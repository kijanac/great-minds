import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";

import * as PgClient from "@effect/sql-pg/PgClient";
import { DatabaseLive } from "@great-minds/database";
import { FileFingerprint } from "@great-minds/domain";
import { Effect, Layer, Redacted, Result, Schema } from "effect";

import { rawFileHash } from "../src/crypto.ts";
import { openLocalConditionalObjectStore } from "../src/storage/local-conditional-object-store.ts";
import type { ConditionalObjectStore } from "../src/storage/object-store.ts";
import {
  ConversationSnapshot,
  ConversionBlocked,
  convertConversationSnapshot,
  isConversationObject,
  type ConversionPlan,
} from "./lib/conversation-history-conversion.ts";
import {
  captureConversationDatabase,
  commitConversationDatabase,
  requireMigrationCopy,
  verifyConversationDatabase,
} from "./lib/conversation-history-cutover.ts";

const encodeJson = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const decodeSnapshot = Schema.decodeUnknownResult(ConversationSnapshot, {
  onExcessProperty: "error",
});

export const migrationDatabaseLayer = (url: string) => {
  const target = new URL(url);
  if (
    !["postgres:", "postgresql:"].includes(target.protocol) ||
    target.hostname !== "127.0.0.1" ||
    target.pathname.length <= 1 ||
    target.search !== "" ||
    target.hash !== ""
  )
    throw new ConversionBlocked("database_must_be_an_explicit_loopback_copy");
  return DatabaseLive.pipe(Layer.provideMerge(PgClient.layer({ url: Redacted.make(url) })));
};

const hashFile = async (path: string) => {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new ConversionBlocked("snapshot_file_must_be_regular");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return Schema.decodeUnknownSync(FileFingerprint)(hash.digest("hex"));
};

const objectFiles = async (root: string): Promise<string[]> => {
  const result: string[] = [];
  const visit = async (prefix: string) => {
    for (const entry of (await readdir(join(root, prefix))).sort()) {
      if (prefix === "" && entry === ".conversation-history.lock") continue;
      const key = prefix === "" ? entry : `${prefix}/${entry}`;
      const stat = await lstat(join(root, key));
      if (stat.isSymbolicLink()) throw new ConversionBlocked("symbolic_link_in_object_copy");
      if (stat.isDirectory()) await visit(key);
      else if (stat.isFile()) result.push(key);
      else throw new ConversionBlocked("unsupported_object_file");
    }
  };
  await visit("");
  return result;
};

const distinctDirectories = (...paths: string[]) => {
  const absolute = paths.map((path) => resolve(path));
  if (
    absolute.some((path, index) =>
      absolute.some(
        (other, otherIndex) =>
          index !== otherIndex && (path === other || path.startsWith(`${other}${sep}`)),
      ),
    )
  )
    throw new ConversionBlocked("snapshot_stage_and_target_must_be_separate");
};

const save = async (path: string, value: string | Uint8Array) => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, value, { flag: "wx", mode: 0o600, flush: true });
};

export const captureSnapshot = (
  objectsDirectory: string,
  backup: string,
  outputDirectory: string,
) =>
  Effect.gen(function* () {
    yield* requireMigrationCopy;
    const source = yield* Effect.promise(() => realpath(objectsDirectory));
    const output = join(
      yield* Effect.promise(() => realpath(dirname(resolve(outputDirectory)))),
      basename(resolve(outputDirectory)),
    );
    yield* Effect.sync(() => distinctDirectories(source, output));
    const before = yield* captureConversationDatabase;
    const snapshot = yield* Effect.tryPromise(async () => {
      await mkdir(output, { mode: 0o700 });
      await copyFile(backup, join(output, "database.dump"));
      const objects: ConversationSnapshot["objects"][number][] = [];
      for (const key of await objectFiles(source)) {
        const bytesHash = await hashFile(join(source, key));
        await mkdir(dirname(join(output, "objects", key)), { recursive: true, mode: 0o700 });
        await copyFile(join(source, key), join(output, "objects", key));
        if ((await hashFile(join(output, "objects", key))) !== bytesHash)
          throw new ConversionBlocked("source_changed_during_capture");
        objects.push({ key, sha256: bytesHash });
      }
      const decoded = decodeSnapshot({
        format: "great-minds/legacy-conversation-snapshot",
        version: 1,
        database_sha256: await hashFile(join(output, "database.dump")),
        ...before,
        objects,
      });
      if (Result.isFailure(decoded)) throw new ConversionBlocked("unsupported_database_snapshot");
      return decoded.success;
    });
    const after = yield* captureConversationDatabase;
    if (!isDeepStrictEqual(before, after))
      return yield* Effect.fail(new ConversionBlocked("database_changed_during_capture"));
    yield* Effect.tryPromise(async () => {
      if (
        !isDeepStrictEqual(
          await objectFiles(source),
          snapshot.objects.map((object) => object.key),
        )
      )
        throw new ConversionBlocked("source_changed_during_capture");
      for (const object of snapshot.objects) {
        if ((await hashFile(join(source, object.key))) !== object.sha256)
          throw new ConversionBlocked("source_changed_during_capture");
      }
      await save(join(output, "snapshot.json"), encodeJson(snapshot));
    });
    return snapshot;
  });

export const loadSnapshot = async (directory: string) => {
  const root = await realpath(directory);
  const sourceHash = await hashFile(join(root, "snapshot.json"));
  const bytes = await readFile(join(root, "snapshot.json"));
  if (rawFileHash(bytes) !== sourceHash)
    throw new ConversionBlocked("snapshot_changed_while_reading");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ConversionBlocked("invalid_snapshot_json");
  }
  const decoded = decodeSnapshot(value);
  if (Result.isFailure(decoded)) throw new ConversionBlocked("unsupported_database_snapshot");
  const snapshot = decoded.success;
  if ((await hashFile(join(root, "database.dump"))) !== snapshot.database_sha256)
    throw new ConversionBlocked("database_backup_changed");
  const keys = await objectFiles(join(root, "objects"));
  if (!isDeepStrictEqual(keys.toSorted(), snapshot.objects.map((object) => object.key).toSorted()))
    throw new ConversionBlocked("snapshot_object_inventory_changed");
  const files = new Map<string, Uint8Array>();
  for (const { key, sha256 } of snapshot.objects) {
    const path = join(root, "objects", key);
    if ((await hashFile(path)) !== sha256) throw new ConversionBlocked("snapshot_object_changed");
    if (isConversationObject(key)) files.set(key, await readFile(path));
  }
  return { root, sha256: rawFileHash(bytes), snapshot, files };
};
type LoadedSnapshot = Awaited<ReturnType<typeof loadSnapshot>>;

export const stageConversion = async (input: LoadedSnapshot, outputDirectory: string) => {
  const output = join(
    await realpath(dirname(resolve(outputDirectory))),
    basename(resolve(outputDirectory)),
  );
  distinctDirectories(input.root, output);
  const plan = convertConversationSnapshot(input.snapshot, input.files);
  await mkdir(output, { mode: 0o700 });
  await save(
    join(output, "report.json"),
    encodeJson({ source_sha256: input.sha256, ...plan.report }),
  );
  await save(join(output, "database-patch.json"), encodeJson(plan.patch));
  for (const { key, history } of plan.histories)
    await save(join(output, "objects", key), history.jsonl);
  return plan;
};

export const verifyStage = async (input: LoadedSnapshot, stage: string) => {
  const plan = convertConversationSnapshot(input.snapshot, input.files);
  if (plan.report.errors.length > 0)
    throw new ConversionBlocked("unresolved_conversion_exceptions");
  if (
    (await readFile(join(stage, "report.json"), "utf8")) !==
      encodeJson({ source_sha256: input.sha256, ...plan.report }) ||
    (await readFile(join(stage, "database-patch.json"), "utf8")) !== encodeJson(plan.patch)
  )
    throw new ConversionBlocked("conversion_plan_changed");
  for (const { key, history } of plan.histories) {
    if ((await readFile(join(stage, "objects", key), "utf8")) !== history.jsonl)
      throw new ConversionBlocked("staged_history_changed");
  }
  return plan;
};

const verifyTargetObjects = async (input: LoadedSnapshot, plan: ConversionPlan, target: string) => {
  const keys = await objectFiles(target);
  if (
    !isDeepStrictEqual(
      keys.toSorted(),
      input.snapshot.objects.map((object) => object.key).toSorted(),
    )
  )
    throw new ConversionBlocked("target_object_inventory_changed");
  const converted = new Map(plan.report.objects.map((object) => [object.key, object.after]));
  for (const object of input.snapshot.objects) {
    const digest = await hashFile(join(target, object.key));
    if (digest !== object.sha256 && digest !== converted.get(object.key))
      throw new ConversionBlocked("target_object_changed");
  }
};

export const installConversationObjects = (plan: ConversionPlan, objects: ConditionalObjectStore) =>
  Effect.gen(function* () {
    if (plan.report.errors.length > 0)
      return yield* Effect.fail(new ConversionBlocked("unresolved_conversion_exceptions"));
    const beforeHashes = new Map(plan.report.objects.map((object) => [object.key, object.before]));
    const ready = [];
    for (const item of plan.histories) {
      const current = yield* objects.getVersioned(item.key);
      const hash = rawFileHash(current.bytes);
      if (hash === item.history.revision.sha256) continue;
      if (hash !== beforeHashes.get(item.key))
        return yield* Effect.fail(new ConversionBlocked("target_history_changed"));
      ready.push({ ...item, version: current.version });
    }
    for (const item of ready)
      yield* objects.putIfVersion(
        item.key,
        item.version,
        new TextEncoder().encode(item.history.jsonl),
      );
  });

export const applyConversion = (input: LoadedSnapshot, stage: string, target: string) =>
  Effect.gen(function* () {
    yield* requireMigrationCopy;
    const targetRoot = yield* Effect.promise(() => realpath(target));
    const stageRoot = yield* Effect.promise(() => realpath(stage));
    yield* Effect.sync(() => distinctDirectories(input.root, stageRoot, targetRoot));
    const plan = yield* Effect.tryPromise(() => verifyStage(input, stageRoot));
    const sql = yield* PgClient.PgClient;
    yield* sql.withTransaction(verifyConversationDatabase(input.snapshot, plan));
    const objects = yield* openLocalConditionalObjectStore(targetRoot);
    yield* Effect.tryPromise(() => verifyTargetObjects(input, plan, targetRoot));
    yield* installConversationObjects(plan, objects);
    yield* commitConversationDatabase(input.snapshot, plan);
    yield* Effect.tryPromise(() => verifyTargetObjects(input, plan, targetRoot));
    for (const item of plan.histories) {
      const file = yield* objects.getVersioned(item.key);
      if (rawFileHash(file.bytes) !== item.history.revision.sha256)
        return yield* Effect.fail(new ConversionBlocked("installed_history_changed"));
    }
    return plan.report.counts;
  });

const main = async () => {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      snapshot: { type: "string" },
      stage: { type: "string" },
      objects: { type: "string" },
      backup: { type: "string" },
      output: { type: "string" },
      "database-url-env": { type: "string" },
      "writers-stopped": { type: "boolean", default: false },
    },
  });
  const required = (value: string | undefined) => {
    if (value === undefined) throw new ConversionBlocked("missing_required_option");
    return value;
  };
  if (positionals[0] === "plan") {
    const plan = await stageConversion(
      await loadSnapshot(required(values.snapshot)),
      required(values.output),
    );
    console.log(
      JSON.stringify({
        ...plan.report.counts,
        blocking: plan.report.errors.length,
        warnings: plan.report.warnings.length,
      }),
    );
    if (plan.report.errors.length > 0) process.exitCode = 2;
    return;
  }
  if (!values["writers-stopped"]) throw new ConversionBlocked("writers_must_be_stopped");
  const database = migrationDatabaseLayer(
    required(process.env[required(values["database-url-env"])]),
  );
  if (positionals[0] === "capture") {
    await Effect.runPromise(
      Effect.scoped(
        captureSnapshot(required(values.objects), required(values.backup), required(values.output)),
      ).pipe(Effect.provide(database)),
    );
    console.log("Snapshot captured; verify restoration before cutover.");
  } else if (positionals[0] === "apply") {
    const counts = await Effect.runPromise(
      Effect.scoped(
        applyConversion(
          await loadSnapshot(required(values.snapshot)),
          required(values.stage),
          required(values.objects),
        ),
      ).pipe(Effect.provide(database)),
    );
    console.log(JSON.stringify(counts));
  } else throw new ConversionBlocked("expected_capture_plan_or_apply");
};

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error: unknown) => {
    console.error(
      error instanceof ConversionBlocked
        ? error.code
        : "Conversion stopped. Keep writers stopped; inspect the protected snapshot and report.",
    );
    process.exitCode = 1;
  });
}
