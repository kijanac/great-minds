import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import * as PgClient from "@effect/sql-pg/PgClient";
import {
  BadRequest,
  CreateReplyRequest,
  Forbidden,
  ReplySnapshot,
  SessionId,
  Uuid,
} from "@great-minds/domain";
import {
  Cause,
  ConfigProvider,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Option,
  Redacted,
  Schema,
  Stream,
} from "effect";

import { makeAppLayer } from "../src/app-layer.ts";
import { AppConfig, AppConfigLive } from "../src/config.ts";
import { ReplyAdmission } from "../src/conversation-history/admission.ts";
import { ReplySettlement } from "../src/conversation-history/settlement.ts";
import { HistoryStore } from "../src/conversation-history/store.ts";
import { LanguageModel } from "../src/llm.ts";
import { RepliesService } from "../src/replies.ts";
import { SessionsService } from "../src/sessions.ts";
import { SharesService } from "../src/shares.ts";
import { sourceIdForKey } from "../src/source-identity.ts";
import { seedConversationReply } from "./lib/seed-conversation.ts";

import { projectSession, publicationExchanges } from "../src/conversation-history/presentation.ts";
import { promptContentHash, rawFileHash } from "../src/crypto.ts";
import { openLocalConditionalObjectStore } from "../src/storage/local-conditional-object-store.ts";
import {
  ConversationSnapshot,
  ConversionBlocked,
  convertConversationSnapshot,
  historyKey,
} from "./lib/conversation-history-conversion.ts";
import {
  captureConversationDatabase,
  requireMigrationCopy,
} from "./lib/conversation-history-cutover.ts";
import { StoredSessionEvent, type ReplyNode } from "./lib/legacy-session-history.ts";
import {
  applyConversion,
  installConversationObjects,
  loadSnapshot,
  migrationDatabaseLayer,
  stageConversion,
  verifyStage,
} from "./migrate-conversation-history.ts";

const url = process.env.REPLY_HISTORY_TEST_DATABASE_URL;
const container = process.env.REPLY_HISTORY_TEST_CONTAINER;
if (url === undefined || container === undefined || !/^[a-f0-9]+$/.test(container))
  throw new Error(
    "Use pnpm test:history-settlement --script packages/server/scripts/rehearse-conversation-conversion.ts",
  );
assert.throws(() => migrationDatabaseLayer(`${url}?host=example.invalid`), ConversionBlocked);
const database = migrationDatabaseLayer(url);
const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    PgClient.PgClient | import("@great-minds/database").Database | import("effect").Scope.Scope
  >,
) => Effect.runPromise(Effect.scoped(effect).pipe(Effect.provide(database)));
const command = promisify(execFile);
const tool = (args: string[]) =>
  command(
    process.execPath,
    [
      "--experimental-strip-types",
      fileURLToPath(new URL("./migrate-conversation-history.ts", import.meta.url)),
      ...args,
    ],
    {
      env: { PATH: process.env.PATH, CONVERSATION_COPY_DATABASE_URL: url },
    },
  );
const root = await mkdtemp(join(tmpdir(), "gm-conversion-proof-"));
const source = join(root, "source");
const snapshotDirectory = join(root, "snapshot");
const stage = join(root, "stage");
const target = join(root, "target");
const checks: string[] = [];
const uuid = (value: number) =>
  Schema.decodeUnknownSync(Uuid)(`00000000-0000-4000-8000-${String(value).padStart(12, "0")}`);
const owner = uuid(1);
const outsider = uuid(2);
const vault = uuid(10);
const main = SessionId.make(uuid(11));
const inline = SessionId.make(uuid(12));
const continued = SessionId.make(uuid(13));
const imported = SessionId.make(uuid(14));
const time = "2026-10-10T12:00:00.000Z";
const sources = [
  {
    label: "raw/source.md",
    type: "raw" as const,
    document_id: null,
    title: "Évidence 漢字",
    scope: null,
    path: null,
    thinking: null,
    full: false,
    ranges: [{ start: 0, end: 1 }],
  },
];
const node = (
  reply: number,
  exchange: number,
  status: ReplyNode["status"],
  question: string,
  answer = "",
  parent: number | null = null,
): ReplyNode => ({
  type: "reply",
  reply_id: uuid(reply),
  exchange_id: uuid(exchange),
  parent_reply_id: parent === null ? null : uuid(parent),
  question,
  answer,
  status,
  ts: new Date(time),
  sources: status === "pending" ? [] : sources,
  messages:
    status === "pending"
      ? []
      : [
          { role: "user", content: question },
          {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: `tool-${reply}`,
                type: "function",
                function: { name: "read_document", arguments: '{"path":"raw/source.md"}' },
              },
            ],
          },
          { role: "tool", tool_call_id: `tool-${reply}`, content: `Saved tool result ${reply}.` },
          { role: "assistant", content: answer },
        ],
});
const first = node(101, 201, "pending", "Original question é 漢字");
const revised = node(
  102,
  201,
  "completed",
  "Revised question",
  "Repeated quote.\n\nRepeated quote. [^1]",
);
const stopped = node(103, 202, "stopped", "Follow-up", "Stopped partial.", 102);
const failed = node(104, 203, "pending", "Retry me", "", 103);
const note = node(105, 204, "completed", "Explain the quote", "An inline note.");
const secondNote = node(106, 205, "completed", "Explain the quote again", "A continued note.");
const fileOnly = node(107, 206, "completed", "File-only question", "Imported literal answer.");
const origin = (offset: number) => ({
  kind: "answer" as const,
  session_id: main,
  exchange_id: uuid(201),
  anchor: "Repeated quote.",
  paragraph: "Repeated quote.",
  paragraph_index: offset,
});
const meta = (id: SessionId, query: string, paragraph: number | null = null) => ({
  type: "meta" as const,
  id,
  query,
  ts: new Date(time),
  user_id: owner,
  origin: paragraph === null ? null : origin(paragraph),
  ...(paragraph === null ? {} : { context: { session_id: main, reply_id: uuid(103) } }),
});
const wire = (events: readonly unknown[]) =>
  new TextEncoder().encode(events.map((event) => JSON.stringify(event)).join("\n") + "\n");
const histories = new Map([
  [
    historyKey(vault, main),
    wire([
      meta(main, first.question),
      first,
      node(102, 201, "pending", revised.question),
      revised,
      revised,
      node(103, 202, "pending", stopped.question, "", 102),
      stopped,
      failed,
    ]),
  ],
  [
    historyKey(vault, inline),
    wire([meta(inline, note.question, 0), node(105, 204, "pending", note.question), note]),
  ],
  [
    historyKey(vault, continued),
    wire([
      meta(continued, secondNote.question, 1),
      node(106, 205, "pending", secondNote.question),
      secondNote,
    ]),
  ],
  [historyKey(vault, imported), wire([meta(imported, fileOnly.question), fileOnly])],
]);
const recorded = [first, revised, stopped, failed, note, secondNote];
const replySession = (reply: ReplyNode) =>
  reply.reply_id === note.reply_id
    ? inline
    : reply.reply_id === secondNote.reply_id
      ? continued
      : main;
const fetchBefore = globalThis.fetch;
let networkCalls = 0;
globalThis.fetch = () => {
  networkCalls++;
  throw new Error("Provider/tool HTTP is forbidden in conversion rehearsal");
};

try {
  await run(
    Effect.gen(function* () {
      yield* requireMigrationCopy;
      const sql = yield* PgClient.PgClient;
      const [{ count }] = yield* sql<{ count: number }>`SELECT count(*)::int AS count FROM users`;
      assert.equal(count, 0);
      yield* sql.unsafe(`
      DROP INDEX uq_replies_live_session;
      DROP INDEX ix_replies_pending_admission;
      DROP INDEX ix_replies_pending_settlement;
      ALTER TABLE replies DROP COLUMN settlement;
      ALTER TABLE replies DROP CONSTRAINT replies_status_check;
      ALTER TABLE replies ADD CONSTRAINT replies_status_check CHECK (status IN ('running','completed','failed','stopped'));
      ALTER TABLE sessions DROP COLUMN history_seq, DROP COLUMN history_sha256, DROP COLUMN placement, DROP COLUMN reply_mode, DROP COLUMN revision;
      ALTER TABLE sessions ADD COLUMN kind text NOT NULL DEFAULT 'session';
      ALTER TABLE sessions ADD CONSTRAINT sessions_kind_check CHECK (kind IN ('session','btw'));
      ALTER TABLE sessions ADD CONSTRAINT sessions_btw_origin_check CHECK (kind != 'btw' OR origin->>'anchor' IS NOT NULL);
      DELETE FROM drizzle.__drizzle_migrations WHERE name IN ('20261011115536_reply_settlement','20261011132114_reply_admission','20261011150356_conversation_app_state');
    `);
      yield* sql`INSERT INTO users (id, email) VALUES (${owner}::uuid, 'owner@conversion.test'), (${outsider}::uuid, 'outsider@conversion.test')`;
      yield* sql`INSERT INTO vaults (id, owner_id, name) VALUES (${vault}::uuid, ${owner}::uuid, 'Conversion fixture')`;
      yield* sql`INSERT INTO vault_memberships (id, vault_id, user_id, role) VALUES (${uuid(20)}::uuid, ${vault}::uuid, ${owner}::uuid, 'OWNER')`;
      for (const [id, query, kind, anchor] of [
        [main, first.question, "session", null],
        [inline, note.question, "btw", origin(0)],
        [continued, secondNote.question, "session", origin(1)],
        [imported, fileOnly.question, "session", null],
      ] as const) {
        yield* sql`INSERT INTO sessions (id, vault_id, user_id, query, origin, kind, created_at, updated_at, idempotency_key)
        VALUES (${id}, ${vault}::uuid, ${owner}::uuid, ${query}, ${JSON.stringify(anchor)}::jsonb, ${kind}, ${time}::timestamptz, ${time}::timestamptz, ${id})`;
      }
      yield* sql`INSERT INTO shares (id, token, subject_kind, subject_id, created_by) VALUES (${uuid(800)}::uuid, 'conversion-bearer', 'session', ${main}::uuid, ${owner}::uuid)`;
      for (const reply of recorded) {
        const sessionId = replySession(reply);
        const isNote = sessionId !== main;
        const request = {
          reply_id: reply.reply_id,
          exchange_id: reply.exchange_id,
          question: reply.question,
          mode: "query",
          model: "fixture/historical",
          origin_scope: "vault",
          extra_instructions: "Preserve this option.",
          session: { kind: "existing", id: sessionId },
        };
        const status = reply.status === "pending" ? "failed" : isNote ? "completed" : "running";
        const answer =
          reply.status === "pending"
            ? `Private failed partial ${reply.reply_id}.`
            : isNote
              ? reply.answer
              : "Stale projection";
        yield* sql`INSERT INTO replies (id, vault_id, user_id, session_id, kind, status, answer, sources, error, version, request, generation_cursor, created_at, updated_at)
        VALUES (${reply.reply_id}::uuid, ${vault}::uuid, ${owner}::uuid, ${sessionId}, ${isNote ? "btw" : "exchange"}, ${status}, ${answer}, ${JSON.stringify(sources)}::jsonb,
          ${status === "failed" ? "provider diagnostic must not be exposed" : null}, 3, ${JSON.stringify(request)}::jsonb, 2, ${time}::timestamptz, ${time}::timestamptz)`;
      }
    }),
  );
  await mkdir(source, { mode: 0o700 });
  for (const [key, bytes] of histories) {
    await mkdir(dirname(join(source, key)), { recursive: true, mode: 0o700 });
    await writeFile(join(source, key), bytes, { mode: 0o600 });
  }
  for (const reply of [note, secondNote]) {
    const key = `vaults/${vault}/operations/replies/${reply.reply_id}.json`;
    await mkdir(dirname(join(source, key)), { recursive: true, mode: 0o700 });
    await writeFile(
      join(source, key),
      JSON.stringify({
        version: 1,
        cursor: 2,
        query: {
          userId: owner,
          vaultId: vault,
          question: reply.question,
          mode: "btw",
          messages: [{ role: "system", content: "Historical system é" }, ...reply.messages],
          turnStart: 1,
          systemPromptHash: promptContentHash("Historical system é"),
          models: ["fixture/historical"],
          selectedModel: "fixture/historical",
        },
        accumulator: { answer: reply.answer, sources: reply.sources },
      }),
      { mode: 0o600 },
    );
  }
  await mkdir(join(source, "vaults", vault, "raw"), { recursive: true });
  await writeFile(
    join(source, "vaults", vault, "raw", "source.md"),
    "Original source, unchanged by conversion. é 漢字\n",
    { mode: 0o600 },
  );
  await command("docker", [
    "exec",
    container,
    "pg_dump",
    "-U",
    "postgres",
    "-Fc",
    "-f",
    "/tmp/conversation-backup.dump",
    "gm_reply_history_test",
  ]);
  await command("docker", [
    "cp",
    `${container}:/tmp/conversation-backup.dump`,
    join(root, "database.dump"),
  ]);
  await tool([
    "capture",
    "--database-url-env",
    "CONVERSATION_COPY_DATABASE_URL",
    "--objects",
    source,
    "--backup",
    join(root, "database.dump"),
    "--output",
    snapshotDirectory,
    "--writers-stopped",
  ]);
  const input = await loadSnapshot(snapshotDirectory);
  const originalDatabase = await run(captureConversationDatabase);
  await tool(["plan", "--snapshot", snapshotDirectory, "--output", stage]);
  const plan = await verifyStage(input, stage);
  assert.deepEqual(plan.report.errors, []);
  assert.equal(plan.report.counts.attempts, 7);
  assert.equal(plan.report.counts.settlements, 7);
  assert.equal(plan.report.counts.preserved_objects, 3);
  for (const object of plan.report.objects) {
    for (const attempt of object.attempts)
      assert(Object.values(attempt.content_equal).every(Boolean));
  }
  assert.deepEqual(convertConversationSnapshot(input.snapshot, input.files).report, plan.report);
  const repeated = await stageConversion(input, join(root, "stage-again"));
  assert.deepEqual(repeated.patch, plan.patch);
  for (const [index, item] of plan.histories.entries())
    assert.equal(repeated.histories[index]?.history.jsonl, item.history.jsonl);
  const rootHistory = plan.histories.find((item) => item.key === historyKey(vault, main))!.history;
  const selected = projectSession(rootHistory).filter((event) => event.type === "exchange");
  assert.equal(selected[0]?.reply_id, revised.reply_id);
  assert.equal(selected[0]?.query, revised.question);
  assert(!JSON.stringify(publicationExchanges(selected)).includes("Private failed partial"));
  assert.equal(rootHistory.turns[0]?.attempts[0]?.accepted.question, first.question);
  for (const [id, offset] of [
    [inline, 0],
    [continued, 1],
  ] as const) {
    const history = plan.histories.find((item) => item.key === historyKey(vault, id))!.history;
    assert.equal(history.header.anchor_reply_id, revised.reply_id);
    assert.equal(history.header.context?.reply_id, stopped.reply_id);
    assert.equal(history.header.origin?.paragraph_index, offset);
    assert.equal(history.turns[0]?.attempts[0]?.settlement?.generation?.mode, "btw");
    assert.deepEqual(
      history.turns[0]?.attempts[0]?.settlement?.context_messages,
      id === inline ? note.messages : secondNote.messages,
    );
  }
  assert.equal(
    plan.patch.sessions.find((pair) => pair.after.id === continued)?.after.reply_mode,
    "query",
  );
  assert.equal(
    plan.histories.find((item) => item.key === historyKey(vault, imported))?.history.turns[0]
      ?.attempts[0]?.accepted.accepted_at,
    null,
  );
  checks.push(
    "determinism-identities-literal-content-tools-retries-anchors-cutoff-mode-unknown-time",
  );

  const convertFiles = (files: ReadonlyMap<string, Uint8Array>, snapshot = input.snapshot) =>
    convertConversationSnapshot(
      {
        ...snapshot,
        objects: snapshot.objects.map((object) => {
          const bytes = files.get(object.key);
          return bytes === undefined ? object : { ...object, sha256: rawFileHash(bytes) };
        }),
      },
      files,
    );
  const decodeEvent = Schema.decodeUnknownSync(StoredSessionEvent);
  const originalEvents = new TextDecoder()
    .decode(input.files.get(historyKey(vault, main))!)
    .trimEnd()
    .split("\n")
    .map((line) => decodeEvent(JSON.parse(line)));
  for (const [code, events] of [
    ["invalid_header", [...originalEvents, originalEvents[0]]],
    ["unsupported_or_invalid_record", [...originalEvents, { type: "future-event" }]],
    ["conflicting_record", [...originalEvents, { ...revised, answer: "Different outcome" }]],
    [
      "pending_record_contains_content",
      originalEvents.map((event) =>
        event.type === "reply" && event.reply_id === first.reply_id
          ? { ...event, answer: "Unaccounted content" }
          : event,
      ),
    ],
  ] as const) {
    const bytes = wire(events);
    const key = historyKey(vault, main);
    const files = new Map(input.files).set(key, bytes);
    const snapshot: ConversationSnapshot = {
      ...input.snapshot,
      objects: input.snapshot.objects.map((object) =>
        object.key === key ? { ...object, sha256: rawFileHash(bytes) } : object,
      ),
    };
    assert(
      convertConversationSnapshot(snapshot, files).report.errors.some(
        (error) => error.code === code,
      ),
    );
  }
  const changedOwner: ConversationSnapshot = {
    ...input.snapshot,
    sessions: input.snapshot.sessions.map((row) =>
      row.id === inline ? { ...row, user_id: outsider } : row,
    ),
  };
  assert(
    convertConversationSnapshot(changedOwner, input.files).report.errors.some(
      (error) => error.code === "registry_header_disagreement",
    ),
  );
  const unresolved: ConversationSnapshot = {
    ...input.snapshot,
    replies: input.snapshot.replies.map((row) =>
      row.id === failed.reply_id ? { ...row, status: "running" } : row,
    ),
  };
  assert(
    convertConversationSnapshot(unresolved, input.files).report.errors.some(
      (error) => error.code === "unresolved_operation",
    ),
  );
  const withoutRetryAcceptance = originalEvents.filter(
    (event) =>
      event.type !== "reply" || event.reply_id !== revised.reply_id || event.status !== "pending",
  );
  assert(
    convertFiles(
      new Map(input.files).set(historyKey(vault, main), wire(withoutRetryAcceptance)),
    ).report.errors.some((error) => error.code === "ambiguous_attempt_order"),
  );
  const ambiguous: ConversationSnapshot = {
    ...input.snapshot,
    replies: input.snapshot.replies.map((row) =>
      row.id === first.reply_id ? { ...row, status: "running" } : row,
    ),
  };
  assert(
    convertFiles(
      new Map(input.files).set(
        historyKey(vault, main),
        wire([...originalEvents, node(101, 201, "completed", first.question, "Earlier success")]),
      ),
      ambiguous,
    ).report.errors.some((error) => error.code === "ambiguous_anchor_reply"),
  );
  const dangling = wire([
    { ...meta(inline, note.question, 0), context: { session_id: main, reply_id: uuid(999) } },
    node(105, 204, "pending", note.question),
    note,
  ]);
  assert(
    convertFiles(new Map(input.files).set(historyKey(vault, inline), dangling)).report.errors.some(
      (error) => error.code === "missing_reply",
    ),
  );
  const cycle = new Map(input.files)
    .set(
      historyKey(vault, inline),
      wire([
        {
          ...meta(inline, note.question, 0),
          context: { session_id: continued, reply_id: secondNote.reply_id },
        },
        node(105, 204, "pending", note.question),
        note,
      ]),
    )
    .set(
      historyKey(vault, continued),
      wire([
        {
          ...meta(continued, secondNote.question, 1),
          context: { session_id: inline, reply_id: note.reply_id },
        },
        node(106, 205, "pending", secondNote.question),
        secondNote,
      ]),
    );
  assert(convertFiles(cycle).report.errors.some((error) => error.code === "context_cycle"));
  const crossOwner = new Map(input.files).set(
    historyKey(vault, inline),
    wire([
      { ...meta(inline, note.question, 0), user_id: outsider },
      node(105, 204, "pending", note.question),
      note,
    ]),
  );
  assert(
    convertFiles(crossOwner, changedOwner).report.errors.some(
      (error) => error.code === "origin_missing_or_cross_owner",
    ),
  );
  const unknownCheckpoint = new Map(input.files).set(
    `vaults/${vault}/operations/replies/${note.reply_id}.json`,
    new TextEncoder().encode('{"version":99}'),
  );
  const unverified = convertFiles(unknownCheckpoint);
  assert.deepEqual(unverified.report.errors, []);
  assert.equal(
    unverified.histories.find((item) => item.key === historyKey(vault, inline))?.history.turns[0]
      ?.attempts[0]?.settlement?.generation,
    null,
  );
  assert(
    unverified.report.warnings.some(
      (warning) => warning.code === "checkpoint_provenance_unverified",
    ),
  );
  const reportText = JSON.stringify(plan.report);
  for (const secret of [
    revised.answer,
    first.question,
    "provider diagnostic must not be exposed",
    "Historical system é",
  ])
    assert(!reportText.includes(secret));
  checks.push(
    "malformed-conflicting-unknown-unresolved-and-ambiguous-dependencies-block-without-inventing-provenance-or-leaking-content",
  );

  await writeFile(join(stage, "report.json"), "changed");
  await assert.rejects(verifyStage(input, stage), ConversionBlocked);
  await writeFile(
    join(stage, "report.json"),
    `${JSON.stringify({ source_sha256: input.sha256, ...plan.report }, null, 2)}\n`,
  );
  const sourceKey = historyKey(vault, main);
  await writeFile(join(snapshotDirectory, "objects", sourceKey), "changed");
  await assert.rejects(loadSnapshot(snapshotDirectory), ConversionBlocked);
  await writeFile(join(snapshotDirectory, "objects", sourceKey), input.files.get(sourceKey)!);
  await cp(join(snapshotDirectory, "objects"), target, { recursive: true });
  await writeFile(join(target, sourceKey), "unrelated destination");
  assert(Exit.isFailure(await run(Effect.exit(applyConversion(input, stage, target)))));
  await writeFile(join(target, sourceKey), input.files.get(sourceKey)!);
  await run(
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      yield* sql`UPDATE vaults SET owner_id = ${outsider}::uuid WHERE id = ${vault}::uuid`;
    }),
  );
  assert(Exit.isFailure(await run(Effect.exit(applyConversion(input, stage, target)))));
  assert.deepEqual(
    await readFile(join(target, sourceKey)),
    Buffer.from(input.files.get(sourceKey)!),
  );
  await run(
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      yield* sql`UPDATE vaults SET owner_id = ${owner}::uuid WHERE id = ${vault}::uuid`;
    }),
  );
  checks.push("changed-source-plan-target-and-permissions-metadata-refused-before-install");

  let writes = 0;
  const interrupted = await run(
    Effect.exit(
      Effect.gen(function* () {
        const objects = yield* openLocalConditionalObjectStore(target);
        yield* installConversationObjects(plan, {
          ...objects,
          putIfVersion: (key, version, bytes) =>
            Effect.gen(function* () {
              yield* objects.putIfVersion(key, version, bytes);
              writes++;
              if (writes === 1) return yield* Effect.die(new Error("injected_after_first_install"));
            }),
        });
      }),
    ),
  );
  assert(Exit.isFailure(interrupted));
  assert.equal(writes, 1);
  assert.equal(
    rawFileHash(await readFile(join(target, plan.histories[0]!.key))),
    plan.histories[0]!.history.revision.sha256,
  );
  assert.deepEqual(await run(captureConversationDatabase), originalDatabase);
  await tool([
    "apply",
    "--database-url-env",
    "CONVERSATION_COPY_DATABASE_URL",
    "--snapshot",
    snapshotDirectory,
    "--stage",
    stage,
    "--objects",
    target,
    "--writers-stopped",
  ]);
  await run(applyConversion(await loadSnapshot(snapshotDirectory), stage, target));
  checks.push(
    "interrupted-object-install-resumes-idempotently-and-repairs-stale-rows-before-unique-index",
  );

  const convertedDatabase = await run(captureConversationDatabase);
  assert.deepEqual(convertedDatabase.controls, originalDatabase.controls);
  for (const { key, history } of plan.histories)
    assert.equal(await readFile(join(target, key), "utf8"), history.jsonl);
  await command("docker", [
    "exec",
    container,
    "pg_restore",
    "-U",
    "postgres",
    "--clean",
    "--if-exists",
    "-d",
    "gm_reply_history_test",
    "/tmp/conversation-backup.dump",
  ]);
  await rm(target, { recursive: true });
  await cp(join(snapshotDirectory, "objects"), target, { recursive: true });
  assert.deepEqual(await run(captureConversationDatabase), originalDatabase);
  for (const object of input.snapshot.objects)
    assert.equal(rawFileHash(await readFile(join(target, object.key))), object.sha256);
  checks.push("actual-pg-dump-restore-and-all-object-bytes-restored-before-reopening-writes");
  await run(applyConversion(await loadSnapshot(snapshotDirectory), stage, target));
  assert.deepEqual(await run(captureConversationDatabase), convertedDatabase);
  const baseConfig = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* AppConfig;
    }).pipe(
      Effect.provide(AppConfigLive),
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: { DATABASE_URL: url, JWT_SECRET: "conversion-fixture-only" },
          }),
        ),
      ),
    ),
  );
  let modelCalls = 0;
  const runtime = ManagedRuntime.make(
    makeAppLayer({
      config: Layer.succeed(AppConfig, {
        ...baseConfig,
        databaseUrl: Redacted.make(url),
        dataDir: target,
        storageBackend: "local",
        openRouterApiKey: Option.some(Redacted.make("fixture-only")),
        parallelApiKey: Option.none(),
      }),
      languageModel: Layer.succeed(LanguageModel, {
        hasApiKey: true,
        streamChat: () => {
          modelCalls++;
          throw new Error("Unplanned model invocation");
        },
        complete: () =>
          Effect.sync(() => {
            modelCalls++;
            throw new Error("Unplanned model invocation");
          }),
      }),
    }),
  );
  try {
    await runtime.runPromise(
      Effect.gen(function* () {
        const conversations = yield* SessionsService;
        const sharing = yield* SharesService;
        const admission = yield* ReplyAdmission;
        const settlement = yield* ReplySettlement;
        const stored = yield* HistoryStore;
        const replies = yield* RepliesService;
        const detail = yield* conversations.readSession(owner, vault, main);
        assert.deepEqual(
          new Set(detail.threads.map((thread) => thread.session.id)),
          new Set([inline, continued]),
        );
        assert(JSON.stringify(detail.events).includes("Private failed partial"));
        const denied = yield* Effect.exit(conversations.readSession(outsider, vault, main));
        assert(Exit.isFailure(denied));
        assert(Cause.squash(denied.cause) instanceof Forbidden);
        const publicView = yield* sharing.resolve("conversion-bearer");
        assert(!JSON.stringify(publicView).includes("Private failed partial"));
        assert(JSON.stringify(publicView).includes("Repeated quote."));
        const refusal = yield* Effect.exit(
          conversations.promoteExchange(owner, vault, main, failed.exchange_id),
        );
        assert(Exit.isFailure(refusal));
        assert(Cause.squash(refusal.cause) instanceof BadRequest);
        const transcript = yield* conversations.readTranscript(owner, vault, inline, note.reply_id);
        assert(JSON.stringify(transcript.prior).includes("Saved tool result 103."));
        assert(!JSON.stringify(transcript.prior).includes("Saved tool result 102."));
        const stream = yield* replies.stream(owner, vault, revised.reply_id);
        const events = yield* Stream.runCollect(stream);
        const message = events.find((event) => event.event === "message");
        assert(message !== undefined);
        const observed = Schema.decodeUnknownSync(Schema.fromJsonString(ReplySnapshot))(
          message.data,
        );
        assert.equal(observed.status, "completed");
        assert.equal(observed.answer, revised.answer);
        assert(events.some((event) => event.event === "done"));
        const migratedReply = plan.patch.replies.find((pair) => pair.after.id === revised.reply_id);
        assert(migratedReply !== undefined);
        assert.equal(
          migratedReply.after.request.command.extra_instructions,
          "Preserve this option.",
        );
        assert.equal(migratedReply.after.request.command.model, "fixture/historical");
        const replay = yield* replies.create(
          owner,
          vault,
          Schema.decodeUnknownSync(CreateReplyRequest)(migratedReply.after.request.command),
        );
        assert.equal(replay.reply_id, revised.reply_id);
        const noteBefore = yield* stored.read({ vault_id: vault, session_id: inline });
        yield* conversations.continueAsSession(owner, vault, inline);
        const noteAfter = yield* stored.read({ vault_id: vault, session_id: inline });
        assert.equal(noteAfter?.history.jsonl, noteBefore?.history.jsonl);
        yield* seedConversationReply(
          owner,
          vault,
          {
            reply_id: uuid(900),
            exchange_id: uuid(901),
            question: "After Continue",
            origin_scope: "vault",
            session: { kind: "existing", id: inline },
          },
          { answer: "New synthetic answer; no model called." },
        );
        const followed = yield* stored.read({ vault_id: vault, session_id: inline });
        assert.equal(
          followed?.history.turns.at(-1)?.attempts[0]?.settlement?.generation?.mode,
          "query",
        );
        assert.equal(followed?.history.turns[0]?.attempts[0]?.settlement?.generation?.mode, "btw");
        yield* admission.retry(owner, vault, failed.reply_id, uuid(902));
        const retry = yield* stored.read({ vault_id: vault, session_id: main });
        const accepted = retry?.history.turns
          .find((turn) => turn.exchange_id === failed.exchange_id)
          ?.attempts.at(-1)?.accepted;
        assert.equal(accepted?.previous_attempt_id, failed.reply_id);
        assert.equal(accepted?.parent_reply_id, stopped.reply_id);
        yield* settlement.begin(uuid(902), {
          status: "completed",
          answer: "Explicit retry result.",
          sources: [],
          context_messages: [
            { role: "user", content: failed.question },
            { role: "assistant", content: "Explicit retry result." },
          ],
          generation: {
            mode: "query",
            system_prompt_hash: {
              scheme: "gm-prompt-v1",
              value: promptContentHash("Synthetic verification only"),
            },
            requested_model: "fixture/static",
          },
        });
        yield* settlement.publish(uuid(902));
        const promoted = yield* conversations.promoteExchange(
          owner,
          vault,
          main,
          revised.exchange_id,
        );
        assert.equal(promoted.mode, "ingested");
        assert.equal(
          promoted.document_id,
          sourceIdForKey(vault, `session:${main}:${revised.exchange_id}`),
        );
      }),
    );
  } finally {
    await runtime.dispose();
  }
  assert.equal(modelCalls, 0);
  checks.push(
    "native-private-read-owner-fence-existing-share-stream-context-continue-followup-retry-and-promotion",
  );
  const changed = await run(Effect.exit(applyConversion(input, stage, target)));
  assert(Exit.isFailure(changed));
  assert(Cause.squash(changed.cause) instanceof ConversionBlocked);
  checks.push("real-native-writes-refuse-reapply-rather-than-overwrite");
  assert.equal(networkCalls, 0);
  await writeFile(
    join(root, "proof.json"),
    `${JSON.stringify({ fixture_only: true, checks, model_calls: modelCalls, network_calls: networkCalls, counts: plan.report.counts }, null, 2)}\n`,
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      artifact_directory: root,
      checks,
      model_calls: modelCalls,
      network_calls: networkCalls,
      counts: plan.report.counts,
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({ fixture_only: true, artifact_directory: root, completed_checks: checks }),
  );
  throw error;
} finally {
  globalThis.fetch = fetchBefore;
}
