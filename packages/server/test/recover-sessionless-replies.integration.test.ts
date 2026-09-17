import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import * as PgClient from "@effect/sql-pg/PgClient";
import { composeAnchoredQuestion, SessionId, Uuid } from "@great-minds/domain";
import { Cause, Effect, Layer, Redacted, Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  type AnchorPlacement,
  groupSessionlessReplies,
  parseSessionlessPrompt,
  recoverSessionlessReplies,
  SessionlessReply,
} from "../scripts/recover-sessionless-replies.ts";
import { convertLegacySession, splitSessionConversations } from "../scripts/migrate-session-replies.ts";
import { ContentStorage, StorageFileMissing, type StorageOwner } from "../src/storage.ts";
import { sourceIdForKey } from "../src/source-identity.ts";

const uuid = (n: number) => Uuid.make(`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`);
const vaultId = uuid(1);
const userId = uuid(2);
const document = "A **claim** needs evidence.\n";
const paragraph = "A claim needs evidence.";
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const reply = (n: number, history: typeof SessionlessReply.Encoded["request"]["history"] = [], question = "Why?"): typeof SessionlessReply.Encoded => ({
  id: uuid(n), vault_id: vaultId, user_id: userId, session_id: null, kind: "ephemeral", status: "completed",
  answer: `Answer ${n}`, sources: [], created_at: `2026-08-19T12:${String(n).padStart(2, "0")}:00.000Z`,
  updated_at: `2026-08-19T12:${String(n).padStart(2, "0")}:10.000Z`,
  request: { kind: "ephemeral", mode: "btw", model: "test/model", origin_path: "raw/test.md", origin_scope: "vault", history,
    question: history.length === 0 ? composeAnchoredQuestion({ quote: "claim", context: paragraph }, question) : question },
});

const placement = (row: typeof SessionlessReply.Encoded): AnchorPlacement => ({
  reply_id: Uuid.make(row.id), question_sha256: sha256(row.request.question), document_sha256: sha256(document), paragraph_index: 0, quote_occurrences: 1,
});

const makeStorage = () => {
  const files = new Map<string, string>([[`vault/${vaultId}/raw/test.md`, document]]);
  const key = (owner: StorageOwner, path: string) => `${owner.kind}/${owner.id}/${path}`;
  let beforeWrite = (_path: string): void => {};
  const service: ContentStorage["Service"] = {
    readText: (owner, path) => Effect.suspend(() => {
      const value = files.get(key(owner, path));
      return value === undefined ? Effect.fail(new StorageFileMissing({ path })) : Effect.succeed(value);
    }),
    writeText: (owner, path, text) => Effect.sync(() => { beforeWrite(path); files.set(key(owner, path), text); }),
    listMarkdown: () => Effect.die("Unexpected listMarkdown"),
    appendText: () => Effect.die("Unexpected appendText"),
    exists: (owner, path) => Effect.sync(() => files.has(key(owner, path))),
    deletePath: () => Effect.die("Unexpected deletePath"),
    clear: () => Effect.die("Unexpected clear"),
  };
  return { files, layer: Layer.succeed(ContentStorage, service), beforeWrite: (callback: typeof beforeWrite) => { beforeWrite = callback; } };
};

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error("DATABASE_URL is required for integration tests");
const SqlLive = PgClient.layer({ url: Redacted.make(databaseUrl) });
const withTables = <A>(test: Effect.Effect<A, unknown, PgClient.PgClient | ContentStorage>, storage: ReturnType<typeof makeStorage>) =>
  Effect.runPromise(Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(Effect.gen(function* () {
      yield* sql`CREATE TEMPORARY TABLE sessions (
        id text NOT NULL, vault_id uuid NOT NULL, user_id uuid NOT NULL, query text NOT NULL, origin jsonb,
        created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, idempotency_key text,
        PRIMARY KEY(id, vault_id), UNIQUE(vault_id, idempotency_key)
      ) ON COMMIT DROP`;
      yield* sql`CREATE TEMPORARY TABLE replies (
        id uuid PRIMARY KEY, vault_id uuid NOT NULL, user_id uuid NOT NULL, session_id text, kind text NOT NULL,
        status text NOT NULL, answer text NOT NULL, sources jsonb NOT NULL, request jsonb NOT NULL,
        created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, version integer DEFAULT 7,
        CONSTRAINT replies_kind_check CHECK(kind IN ('exchange','btw','ephemeral')),
        FOREIGN KEY(session_id,vault_id) REFERENCES sessions(id,vault_id)
      ) ON COMMIT DROP`;
      return yield* test;
    }));
  }).pipe(Effect.provide(Layer.merge(SqlLive, storage.layer))));

const insertReply = (row: typeof SessionlessReply.Encoded) => Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  yield* sql`INSERT INTO replies (id,vault_id,user_id,session_id,kind,status,answer,sources,request,created_at,updated_at)
    VALUES (${row.id}::uuid,${row.vault_id}::uuid,${row.user_id}::uuid,NULL,'ephemeral',${row.status},${row.answer},
      ${JSON.stringify(row.sources)}::jsonb,${JSON.stringify(row.request)}::jsonb,${row.created_at}::timestamptz,${row.updated_at}::timestamptz)`;
});

describe("historical BTW reconstruction", () => {
  it("matches full histories and keeps original passage text even when its quote repeats", () => {
    const first = reply(10);
    const second = reply(11, [{ role: "user", content: first.request.question }, { role: "assistant", content: first.answer }], "Then what?");
    const rows = [second, first].map((row) => Schema.decodeUnknownSync(SessionlessReply)(row));
    expect(groupSessionlessReplies(rows).map((thread) => thread.map((row) => row.id))).toEqual([[first.id, second.id]]);
    const repeated = "The claim supports the claim.";
    expect(parseSessionlessPrompt(composeAnchoredQuestion({ quote: "claim", context: repeated }, "Which?")))
      .toEqual({ anchor: "claim", paragraph: repeated, question: "Which?" });
  });

  it("refuses missing predecessors, branches, and ambiguous prompt delimiters", () => {
    const first = reply(10);
    const history = [{ role: "user" as const, content: first.request.question }, { role: "assistant" as const, content: first.answer }];
    const second = reply(11, history);
    const third = reply(12, history);
    const decode = Schema.decodeUnknownSync(SessionlessReply);
    expect(() => groupSessionlessReplies([decode(second)])).toThrow("no unique historical predecessor");
    expect(() => groupSessionlessReplies([first, second, third].map((row) => decode(row)))).toThrow("would branch");
    expect(() => groupSessionlessReplies([first, { ...first, id: uuid(9) }, second].map((row) => decode(row)))).toThrow("no unique historical predecessor");
    expect(() => parseSessionlessPrompt("A question without recorded passage metadata")).toThrow("no unique passage");
  });

  it("recovers a linear thread, reuses an existing turn, preserves backups, and permits both SQL migrations", async () => {
    const storage = makeStorage();
    const first: typeof SessionlessReply.Encoded = { ...reply(10), sources: [{ type: "raw", label: "Source", title: "Original title",
      path: null, scope: null, thinking: null, full: true, ranges: [{ start: 0, end: 2 }] }] };
    const second = reply(11, [{ role: "user", content: first.request.question }, { role: "assistant", content: first.answer }], "Follow-up?");
    const alreadySaved = reply(12, [], "Saved question?");
    const savedId = SessionId.make("saved-conversation");
    const origin = { doc_path: "raw/test.md", origin_scope: "vault", anchor: "claim", paragraph: null, paragraph_index: null };
    const originalJsonl = [
      { type: "meta", id: savedId, query: "Saved question?", user_id: userId, origin, ts: alreadySaved.created_at },
      { type: "exchange", exId: "ex-original", query: "Saved question?", answer: alreadySaved.answer, ts: alreadySaved.created_at },
    ].map((event) => JSON.stringify(event) + "\n").join("");
    storage.files.set(`vault/${vaultId}/sessions/${savedId}.jsonl`, originalJsonl);
    storage.files.set(`vault/${vaultId}/sessions/${savedId}.md`, "Original Markdown");
    const sqlMigrations = await Promise.all([
      "20260908155003_session_reply_requests", "20260917175636_btw_conversations",
    ].map((name) => readFile(new URL(`../../database/drizzle/${name}/migration.sql`, import.meta.url), "utf8")));
    await withTables(Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      yield* sql`INSERT INTO sessions VALUES (${savedId},${vaultId}::uuid,${userId}::uuid,'Saved question?',${JSON.stringify(origin)}::jsonb,
        ${alreadySaved.created_at}::timestamptz,${alreadySaved.updated_at}::timestamptz,NULL)`;
      for (const row of [first, second, alreadySaved]) yield* insertReply(row);
      const placements = [placement(first), placement(alreadySaved)];
      const before = new Map(storage.files);
      expect(yield* recoverSessionlessReplies(placements)).toEqual({ mode: "preview", threads: 2, created: 1, reused: 1, replies: 3, paragraphAnchors: 0 });
      expect(storage.files).toEqual(before);
      expect((yield* sql`SELECT id FROM replies WHERE session_id IS NULL`)).toHaveLength(3);
      expect(yield* recoverSessionlessReplies(placements, true)).toMatchObject({ mode: "applied", created: 1, reused: 1 });
      for (const migration of sqlMigrations) for (const statement of migration.split("--> statement-breakpoint")) yield* sql.unsafe(statement);
      const sessions = yield* sql<{ id: string; kind: string }>`SELECT id,kind FROM sessions`;
      expect(sessions).toHaveLength(2);
      expect(sessions.every((session) => session.kind === "btw")).toBe(true);
      const recovered = sessions.find((session) => session.id !== savedId)!;
      const jsonl = storage.files.get(`vault/${vaultId}/sessions/${recovered.id}.jsonl`)!;
      const events = convertLegacySession(jsonl.trim().split("\n").map((line) => JSON.parse(line)), () => uuid(50));
      const nodes = events.filter((event) => event.type === "reply");
      expect(nodes.map((node) => node.reply_id)).toEqual([first.id, second.id]);
      expect(nodes[0]?.messages).toEqual([{ role: "user", content: first.request.question }, { role: "assistant", content: first.answer }]);
      expect(nodes[0]?.sources).toEqual(first.sources.map((source) => ({ ...source, document_id: null })));
      expect(nodes[1]?.parent_reply_id).toBe(first.id);
      expect(splitSessionConversations(events, vaultId, "btw")).toHaveLength(1);
      const savedJsonl = storage.files.get(`vault/${vaultId}/sessions/${savedId}.jsonl`)!;
      const savedMeta = JSON.parse(savedJsonl.split("\n")[0]!);
      expect(savedMeta.origin).toMatchObject({ paragraph, paragraph_index: 0 });
      const savedRows = yield* sql<{ origin: unknown }>`SELECT origin FROM sessions WHERE id = ${savedId}`;
      expect(savedRows[0]?.origin).toEqual(savedMeta.origin);
      expect(JSON.parse(savedJsonl.trim().split("\n")[1]!)).toMatchObject({ reply_id: alreadySaved.id, exId: "ex-original" });
      const backup = JSON.parse(storage.files.get(`vault/${vaultId}/migrations/sessionless-replies/${alreadySaved.id}/backup.json`)!);
      expect(backup.jsonl).toBe(originalJsonl);
      expect(backup.markdown).toBe("Original Markdown");
      expect(backup.replies[0]).toMatchObject({ id: alreadySaved.id, session_id: null, kind: "ephemeral", version: 7, request: alreadySaved.request });
      const persisted = yield* sql<{ id: string; version: number; kind: string; session_id: string; request: { model: string; session: { kind: string; id: string } } }>`SELECT * FROM replies ORDER BY created_at`;
      expect(persisted.map((row) => row.id)).toEqual([first.id, second.id, alreadySaved.id]);
      expect(persisted.every((row) => row.version === 7 && row.kind === "exchange" && row.request.model === "test/model" && row.request.session.id === row.session_id)).toBe(true);
      const after = new Map(storage.files);
      expect(yield* recoverSessionlessReplies(placements, true)).toMatchObject({ threads: 0, replies: 0 });
      expect(storage.files).toEqual(after);
    }), storage);
  });

  it("retries a partial file write from immutable originals without creating another conversation", async () => {
    const storage = makeStorage();
    const first = reply(10);
    await withTables(Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      yield* insertReply(first);
      let fail = true;
      storage.beforeWrite((path) => { if (path.endsWith(".md") && fail) { fail = false; throw new Error("Interrupted after JSONL write"); } });
      const result = yield* Effect.exit(recoverSessionlessReplies([placement(first)], true));
      expect(result._tag).toBe("Failure");
      expect((yield* sql`SELECT * FROM sessions`)).toHaveLength(0);
      const backupKey = `vault/${vaultId}/migrations/sessionless-replies/${first.id}/backup.json`;
      const backup = storage.files.get(backupKey);
      expect(backup).toBeDefined();
      expect(yield* recoverSessionlessReplies([placement(first)], true)).toMatchObject({ created: 1, replies: 1 });
      expect(storage.files.get(backupKey)).toBe(backup);
      expect((yield* sql`SELECT * FROM sessions`)).toHaveLength(1);
    }), storage);
  });

  it("rejects changed documents and conflicting destination histories before writing", async () => {
    const storage = makeStorage();
    const first = reply(10);
    await withTables(Effect.gen(function* () {
      yield* insertReply(first);
      storage.files.set(`vault/${vaultId}/raw/test.md`, "Changed source");
      const changed = yield* Effect.exit(recoverSessionlessReplies([placement(first)], true));
      expect(changed._tag).toBe("Failure");
      if (changed._tag === "Failure") expect(Cause.pretty(changed.cause)).toContain("changed after anchor review");
      expect(storage.files.size).toBe(1);
      storage.files.set(`vault/${vaultId}/raw/test.md`, document);
      const id = sourceIdForKey(vaultId, `recovered-btw:${first.id}`);
      storage.files.set(`vault/${vaultId}/sessions/${id}.jsonl`, "Unrelated history");
      const collision = yield* Effect.exit(recoverSessionlessReplies([placement(first)], true));
      expect(collision._tag).toBe("Failure");
      if (collision._tag === "Failure") expect(Cause.pretty(collision.cause)).toContain("contains changed history");
      expect(storage.files.size).toBe(2);
    }), storage);
  });
});
