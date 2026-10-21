import { Database, sourceIncarnations, users, vaults } from "@great-minds/database";
import { Uuid } from "@great-minds/domain";
import { eq } from "drizzle-orm";
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Schema, type Scope } from "effect";
import { assert, beforeEach, expect, it } from "vitest";

import { fileContentHash } from "../src/crypto.ts";
import { StructuredLogger } from "../src/logging.ts";
import { SourceDocumentsService, SourceDocumentsServiceLive } from "../src/source-documents.ts";
import {
  encodeSourceControl,
  identifySourceMarkdown,
  readSourceControl,
} from "../src/source-identity.ts";
import { ContentStorage, vaultOwner } from "../src/storage.ts";
import { runHistoryDatabase } from "./fixtures/reply-history-database.ts";
import { versionedSourceStorage } from "./fixtures/source-documents.ts";

const uuid = Schema.decodeUnknownSync(Uuid);
const id = {
  user: uuid("00000000-0000-4000-8000-000000015001"),
  vault: uuid("00000000-0000-4000-8000-000000015101"),
  source: uuid("00000000-0000-4000-8000-000000015501"),
};
const path = "raw/docs/source.md";
const files = new Map<string, string>();
const conditional = versionedSourceStorage(files);
let beforeWrite: (content: string, version: string | null) => Effect.Effect<void> = () =>
  Effect.void;
let afterWrite: (content: string) => Effect.Effect<void> = () => Effect.void;
let writeCount = 0;
const storage: ContentStorage["Service"] = {
  ...conditional,
  listMarkdown: (_owner, scope) =>
    Effect.sync(() =>
      [...files]
        .filter(([path]) => path.startsWith(`${scope}/`))
        .map(([path, content]) => ({ path, etag: fileContentHash(content) })),
    ),
  writeText: (_owner, path, content) =>
    Effect.sync(() => {
      files.set(path, content);
    }),
  writeTextIfVersion: (owner, path, version, content) =>
    Effect.gen(function* () {
      writeCount += 1;
      yield* beforeWrite(content, version);
      yield* conditional.writeTextIfVersion(owner, path, version, content);
      yield* afterWrite(content);
    }),
  deletePath: (_owner, path) =>
    Effect.sync(() => {
      files.delete(path);
    }),
  clear: () => Effect.sync(() => files.clear()),
};
const SourcesLive = SourceDocumentsServiceLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(ContentStorage, storage),
      Layer.succeed(StructuredLogger, {
        info: () => Effect.void,
        warn: () => Effect.void,
        error: () => Effect.void,
      }),
    ),
  ),
);
const run = <A>(
  effect: Effect.Effect<A, unknown, Database | SourceDocumentsService | Scope.Scope>,
) => runHistoryDatabase(effect.pipe(Effect.provide(SourcesLive)));
const publish = (body: string) =>
  Effect.gen(function* () {
    const sources = yield* SourceDocumentsService;
    const admission = yield* sources.admit(id.vault, id.source, path);
    yield* sources.write(admission, body, null);
    const document = yield* sources.getById(id.vault, id.source);
    assert(document !== undefined);
    return document;
  });
const lifetimes = Effect.gen(function* () {
  const db = yield* Database;
  return yield* db.query((tx) =>
    tx.select().from(sourceIncarnations).where(eq(sourceIncarnations.sourceId, id.source)),
  );
});

beforeEach(async () => {
  files.clear();
  writeCount = 0;
  beforeWrite = () => Effect.void;
  afterWrite = () => Effect.void;
  await run(
    Effect.gen(function* () {
      const db = yield* Database;
      yield* db.query((tx) => tx.delete(users));
      yield* db.query((tx) =>
        tx.insert(users).values({ id: id.user, email: "lifetimes@example.invalid" }),
      );
      yield* db.query((tx) =>
        tx.insert(vaults).values({ id: id.vault, name: "Source lifetimes", ownerId: id.user }),
      );
    }),
  );
});

it("does not rediscover failed deletions or reuse their ownership on repeated imports", () =>
  run(
    Effect.gen(function* () {
      const sources = yield* SourceDocumentsService;
      const original = yield* publish("# Source\n\nOriginal private body.");
      beforeWrite = (content) =>
        readSourceControl(content)?.state === "deleted"
          ? Effect.die(new Error("Injected cleanup outage"))
          : Effect.void;
      expect(yield* sources.deleteSource(id.vault, id.source)).toBe(true);
      expect(files.get(path)).toContain("Original private body.");
      expect(yield* sources.discover(id.vault)).toEqual([]);
      expect(yield* sources.getById(id.vault, id.source)).toBeUndefined();
      beforeWrite = () => Effect.void;

      const replacement = yield* publish("# Source\n\nReplacement body.");
      expect(replacement.id).toBe(original.id);
      expect(replacement.incarnationId).not.toBe(original.incarnationId);
      const stored = files.get(path);
      expect(yield* sources.reconcileDeletionsOnce()).toBe(1);
      expect(files.get(path)).toBe(stored);
      const stale = yield* Effect.exit(sources.admission(id.vault, original.incarnationId));
      assert(Exit.isFailure(stale));
      expect(Cause.squash(stale.cause)).toMatchObject({ _tag: "Conflict" });
      let projected = false;
      expect(
        yield* sources.withCurrent(original, () =>
          Effect.sync(() => {
            projected = true;
          }),
        ),
      ).toBe(false);
      expect(projected).toBe(false);
      expect(yield* sources.readCurrent(original)).toBeUndefined();

      expect(yield* sources.deleteSource(id.vault, id.source, replacement.incarnationId)).toBe(
        true,
      );
      const retired = yield* lifetimes;
      expect(retired).toHaveLength(2);
      expect(retired.every((row) => row.completedAt !== null && row.deletedAt !== null)).toBe(true);
      expect(retired.find((row) => row.id === original.incarnationId)?.attemptCount).toBe(2);
      expect(retired.find((row) => row.id === replacement.incarnationId)?.attemptCount).toBe(1);
      expect(files.get(path)).toBe(
        encodeSourceControl({
          sourceId: id.source,
          incarnationId: replacement.incarnationId,
          state: "deleted",
        }),
      );
      expect(yield* storage.exists(vaultOwner(id.vault), path)).toBe(false);
      expect(yield* sources.discover(id.vault)).toEqual([]);
    }),
  ));

it("fences an already-started cleanup PUT against a replacement source", () =>
  run(
    Effect.gen(function* () {
      const sources = yield* SourceDocumentsService;
      const original = yield* publish("# Original");
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      beforeWrite = (content) =>
        Effect.gen(function* () {
          const control = readSourceControl(content);
          if (control?.state === "deleted" && control.incarnationId === original.incarnationId) {
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
          }
        });
      const deleting = yield* Effect.forkScoped(sources.deleteSource(id.vault, id.source));
      yield* Deferred.await(started);
      const replacement = yield* publish("# Replacement");
      const stored = files.get(path);
      beforeWrite = () => Effect.void;
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(deleting)).toBe(true);
      expect(
        (yield* lifetimes).find((row) => row.id === original.incarnationId)?.completedAt,
      ).toBeNull();
      expect(yield* sources.reconcileDeletionsOnce()).toBe(1);
      expect(files.get(path)).toBe(stored);
      expect((yield* sources.getById(id.vault, id.source))?.incarnationId).toBe(
        replacement.incarnationId,
      );
    }),
  ));

it.each(["reservation", "body"] as const)(
  "fences a delayed %s PUT after delete and re-import",
  (phase) =>
    run(
      Effect.gen(function* () {
        const sources = yield* SourceDocumentsService;
        const original = yield* publish("# Original");
        if (phase === "reservation") files.delete(path);
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        beforeWrite = (content, version) =>
          Effect.gen(function* () {
            const delayed =
              phase === "reservation"
                ? readSourceControl(content)?.state === "reserved"
                : content.includes("Delayed content");
            if (delayed) {
              if (phase === "reservation") expect(version).toBeNull();
              else expect(version).not.toBeNull();
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
            }
          });
        const writing = yield* Effect.forkScoped(
          Effect.exit(sources.write(original, "# Delayed content", null)),
        );
        yield* Deferred.await(started);
        expect(yield* sources.deleteSource(id.vault, id.source)).toBe(true);
        const replacement = yield* publish("# Replacement");
        const stored = files.get(path);
        beforeWrite = () => Effect.void;
        yield* Deferred.succeed(release, undefined);
        const outcome = yield* Fiber.join(writing);
        assert(Exit.isFailure(outcome));
        expect(Cause.squash(outcome.cause)).toMatchObject({ _tag: "Conflict" });
        expect(files.get(path)).toBe(stored);
        expect((yield* sources.getById(id.vault, id.source))?.incarnationId).toBe(
          replacement.incarnationId,
        );
      }),
    ),
);

it("repairs registration after an uncertain body PUT without repeating it", () =>
  run(
    Effect.gen(function* () {
      const sources = yield* SourceDocumentsService;
      const admission = yield* sources.admit(id.vault, id.source, path);
      afterWrite = (content) =>
        readSourceControl(content) === undefined
          ? Effect.die(new Error("Lost body-write acknowledgment"))
          : Effect.void;
      const first = yield* Effect.exit(sources.write(admission, "# Saved exactly once", null));
      assert(Exit.isFailure(first));
      expect(yield* sources.getById(id.vault, id.source)).toBeUndefined();
      const stored = files.get(path);
      const writes = writeCount;
      afterWrite = () => Effect.void;
      expect(yield* sources.write(admission, "# Saved exactly once", null)).toBe(id.source);
      expect(writeCount).toBe(writes);
      expect(files.get(path)).toBe(stored);
      expect((yield* sources.getById(id.vault, id.source))?.incarnationId).toBe(
        admission.incarnationId,
      );
    }),
  ));

it("defers legacy cleanup when live managed bytes lose their ownership header", () =>
  run(
    Effect.gen(function* () {
      const sources = yield* SourceDocumentsService;
      const db = yield* Database;
      const current = yield* publish("# Managed replacement\n\nKeep this body.\n");
      const owned = files.get(path);
      assert(owned !== undefined);
      yield* db.query((tx) =>
        tx.insert(sourceIncarnations).values({
          sourceId: id.source,
          vaultId: id.vault,
          filePath: path,
          unversioned: true,
          deletedAt: new Date(0),
          createdAt: new Date(0),
          updatedAt: new Date(0),
        }),
      );
      const ambiguous = identifySourceMarkdown(owned, id.source);
      files.set(path, ambiguous);
      yield* sources.reconcileDeletionsOnce();
      expect(files.get(path)).toBe(ambiguous);
      expect(
        (yield* lifetimes).find((row) => row.id !== current.incarnationId)?.completedAt,
      ).toBeNull();
      files.set(path, owned);
      yield* sources.reconcileDeletionsOnce();
      expect(files.get(path)).toBe(owned);
      expect(
        (yield* lifetimes).find((row) => row.id !== current.incarnationId)?.completedAt,
      ).toBeInstanceOf(Date);
    }),
  ));
