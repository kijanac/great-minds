import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import * as PgClient from "@effect/sql-pg/PgClient";
import {
  composeAnchoredQuestion,
  CreateReplyRequest,
  IsoDateTime,
  QueryRequest,
  SessionId,
  Uuid,
} from "@great-minds/domain";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";

import { AppConfigLive } from "../src/config.ts";
import { PgClientLive } from "../src/db.ts";
import { StructuredLoggerLive } from "../src/logging.ts";
import { projectSession, renderSessionMarkdown, StoredSessionEvent, StoredSessionMeta } from "../src/sessions.ts";
import { sourceIdForKey } from "../src/source-identity.ts";
import { ContentStorage, StorageServicesLive, userOwner, vaultOwner } from "../src/storage.ts";
import { LegacyReplySource } from "./migrate-session-replies.ts";

const Message = Schema.Struct({ role: Schema.Literals(["user", "assistant"]), content: Schema.String });
export const SessionlessReply = Schema.Struct({
  id: Uuid,
  vault_id: Uuid,
  user_id: Uuid,
  session_id: Schema.Null,
  kind: Schema.Literal("ephemeral"),
  status: Schema.Literal("completed"),
  answer: Schema.String,
  sources: Schema.Array(LegacyReplySource),
  created_at: IsoDateTime,
  updated_at: IsoDateTime,
  request: Schema.Struct({
    ...QueryRequest.fields,
    kind: Schema.Literal("ephemeral"),
    origin_path: Schema.NonEmptyString,
    history: Schema.Array(Message),
  }),
});
export type SessionlessReply = typeof SessionlessReply.Type;

const Sha256 = Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/)));
export const AnchorPlacement = Schema.Struct({
  reply_id: Uuid,
  question_sha256: Sha256,
  document_sha256: Sha256,
  paragraph_index: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  quote_occurrences: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
});
export type AnchorPlacement = typeof AnchorPlacement.Type;

const SessionRow = Schema.Struct({ id: SessionId, vault_id: Uuid, user_id: Uuid });
const JsonEvents = Schema.Array(Schema.Record(Schema.String, Schema.Unknown));
const Backup = Schema.Struct({
  sessionId: SessionId,
  session: Schema.Unknown,
  replies: Schema.Array(Schema.Unknown),
  jsonl: Schema.NullOr(Schema.String),
  markdown: Schema.NullOr(Schema.String),
  placement: AnchorPlacement,
});
const encodeEvent = Schema.encodeSync(StoredSessionEvent);
const encodeRequest = Schema.encodeSync(CreateReplyRequest);
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const parseEvents = (text: string) => Schema.decodeUnknownSync(JsonEvents)(text.trim().split("\n").map((line) => JSON.parse(line)));

export const parseSessionlessPrompt = (prompt: string) => {
  const candidates = [...prompt.matchAll(/\n\nHighlighted: "/g)].flatMap((start) => {
    const quoteStart = start.index + start[0].length;
    return [...prompt.slice(quoteStart).matchAll(/"\n\n/g)].map((end) => ({
      paragraph: prompt.slice("Passage:\n> ".length, start.index),
      anchor: prompt.slice(quoteStart, quoteStart + end.index),
      question: prompt.slice(quoteStart + end.index + end[0].length),
    }));
  }).filter((candidate) => candidate.anchor.length > 0 && candidate.question.trim().length > 0 &&
    candidate.paragraph.includes(candidate.anchor) && composeAnchoredQuestion({
      quote: candidate.anchor, context: candidate.paragraph,
    }, candidate.question) === prompt);
  if (candidates.length !== 1) throw new Error("Historical BTW prompt has no unique passage and question");
  return candidates[0]!;
};

export const groupSessionlessReplies = (rows: readonly SessionlessReply[]) => {
  const ordered = [...rows].sort((left, right) => left.created_at.getTime() - right.created_at.getTime());
  const threads: SessionlessReply[][] = [];
  for (const row of ordered) {
    if (row.request.history.length === 0) {
      threads.push([row]);
      continue;
    }
    const predecessors = ordered.filter((prior) => prior.created_at < row.created_at &&
      prior.vault_id === row.vault_id && prior.user_id === row.user_id &&
      prior.request.origin_path === row.request.origin_path && prior.request.origin_scope === row.request.origin_scope &&
      row.request.history.length === prior.request.history.length + 2 &&
      [...prior.request.history, { role: "user", content: prior.request.question }, { role: "assistant", content: prior.answer }]
        .every((message, index) => message.role === row.request.history[index]?.role && message.content === row.request.history[index]?.content));
    if (predecessors.length !== 1) throw new Error(`Reply ${row.id} has no unique historical predecessor`);
    const thread = threads.find((candidate) => candidate.at(-1)?.id === predecessors[0]!.id);
    if (thread === undefined) throw new Error(`Reply ${row.id} would branch a historical BTW`);
    thread.push(row);
  }
  return threads;
};

const latestExchanges = (events: typeof JsonEvents.Type) => {
  const latest = new Map<string, number>();
  const metaIndex = events.findLastIndex((event) => event.type === "meta");
  if (metaIndex < 0) throw new Error("Saved conversation has no metadata");
  for (let index = metaIndex + 1; index < events.length; index++) {
    const event = events[index]!;
    if (event.type === "exchange" && typeof event.exId === "string") latest.set(event.exId, index);
  }
  return [...latest.values()];
};

export const recoverSessionlessReplies = (placements: readonly AnchorPlacement[], apply = false) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const storage = yield* ContentStorage;
    const running = yield* sql`SELECT id FROM replies WHERE status = 'running' LIMIT 1`;
    if (apply && running.length > 0) throw new Error("Stop reply generation before recovering historical BTWs");
    const rawReplies = yield* sql<{ row: unknown }>`SELECT to_jsonb(replies) AS row FROM replies WHERE session_id IS NULL OR kind = 'ephemeral' ORDER BY created_at, id`;
    const rows = rawReplies.map(({ row }) => Schema.decodeUnknownSync(SessionlessReply)(row));
    const originals = new Map(rows.map((row, index) => [row.id, rawReplies[index]!.row]));
    const threads = groupSessionlessReplies(rows);
    const placementById = new Map(placements.map((placement) => [placement.reply_id, placement]));
    if (placementById.size !== placements.length) throw new Error("Anchor placements contain duplicate reply IDs");
    const readOptional = (owner: ReturnType<typeof vaultOwner>, path: string) => storage.readText(owner, path).pipe(
      Effect.result,
      Effect.map((result) => result._tag === "Success" ? result.success : null),
    );
    const rawSessions = threads.length === 0 ? [] : yield* sql<{ row: unknown }>`SELECT to_jsonb(sessions) AS row FROM sessions`;
    const saved = yield* Effect.forEach(rawSessions, ({ row: raw }) => Effect.gen(function* () {
      const row = Schema.decodeUnknownSync(SessionRow)(raw);
      const jsonl = yield* storage.readText(vaultOwner(row.vault_id), `sessions/${row.id}.jsonl`);
      const events = parseEvents(jsonl);
      const metadata = events.findLast((event) => event.type === "meta");
      const origin = metadata?.origin;
      const tagged = typeof origin === "object" && origin !== null ? { kind: "document", ...origin } : origin;
      const meta = Schema.decodeUnknownSync(StoredSessionMeta)({ ...metadata, origin: tagged });
      if (meta.id !== row.id || meta.user_id !== row.user_id) throw new Error(`Session ${row.id} metadata differs from its owner or identity`);
      return { row, raw, jsonl, meta, events, exchanges: latestExchanges(events) };
    }));
    const plans = yield* Effect.forEach(threads, (thread) => Effect.gen(function* () {
      const first = thread[0]!;
      const prompt = parseSessionlessPrompt(first.request.question);
      const placement = placementById.get(first.id);
      if (placement === undefined || placement.question_sha256 !== sha256(first.request.question)) {
        throw new Error(`BTW ${first.id} requires a reviewed anchor placement for its original prompt`);
      }
      const documentOwner = first.request.origin_scope === "personal" ? userOwner(first.user_id) : vaultOwner(first.vault_id);
      const document = yield* storage.readText(documentOwner, first.request.origin_path);
      if (sha256(document) !== placement.document_sha256) throw new Error(`Origin document for BTW ${first.id} changed after anchor review`);
      const candidates = saved.filter((session) => session.row.vault_id === first.vault_id && session.row.user_id === first.user_id &&
        session.meta.origin?.kind === "document" && session.meta.origin.doc_path === first.request.origin_path &&
        session.meta.origin.origin_scope === first.request.origin_scope && session.meta.origin.anchor === prompt.anchor &&
        thread.every((reply, index) => {
          const event = session.events[session.exchanges[index] ?? -1];
          return event?.query === (index === 0 ? prompt.question : reply.request.question) && event.answer === reply.answer;
        }));
      if (candidates.length > 1) throw new Error(`BTW ${first.id} matches more than one saved conversation`);
      const existing = candidates[0];
      if (existing?.meta.origin?.paragraph != null && existing.meta.origin.paragraph !== prompt.paragraph) {
        throw new Error(`Saved conversation for BTW ${first.id} has different passage context`);
      }
      const id = existing?.row.id ?? SessionId.make(sourceIdForKey(first.vault_id, `recovered-btw:${first.id}`));
      if (existing === undefined && saved.some((session) => session.row.vault_id === first.vault_id && session.row.id === id)) {
        throw new Error(`Recovery destination ${id} already exists`);
      }
      const origin = { kind: "document", doc_path: first.request.origin_path, origin_scope: first.request.origin_scope,
        anchor: prompt.anchor, paragraph: prompt.paragraph, paragraph_index: placement.paragraph_index } as const;
      const events: StoredSessionEvent[] = [{ type: "meta", id, query: prompt.question, ts: first.created_at, user_id: first.user_id, origin }];
      const updates = thread.map((reply, index) => {
        const question = index === 0 ? prompt.question : reply.request.question;
        const exchangeId = sourceIdForKey(reply.vault_id, `recovered-reply:${reply.id}`);
        events.push({ type: "reply", reply_id: reply.id, parent_reply_id: thread[index - 1]?.id ?? null,
          exchange_id: exchangeId, question, status: "completed", answer: reply.answer, sources: reply.sources,
          messages: [{ role: "user", content: reply.request.question }, { role: "assistant", content: reply.answer }], ts: reply.created_at });
        return { id: reply.id, request: Schema.decodeUnknownSync(CreateReplyRequest)({ ...reply.request,
          question, reply_id: reply.id, exchange_id: exchangeId, session: { kind: "existing", id } }) };
      });
      const owner = vaultOwner(first.vault_id);
      const backupPath = `migrations/sessionless-replies/${first.id}/backup.json`;
      const backupText = yield* readOptional(owner, backupPath);
      const previous = backupText === null ? null : Schema.decodeUnknownSync(Backup)(JSON.parse(backupText));
      const originalJsonl = previous === null ? existing?.jsonl ?? null : previous.jsonl;
      const originalMarkdown = previous === null ? yield* readOptional(owner, `sessions/${id}.md`) : previous.markdown;
      const originalRows = thread.map((reply) => originals.get(reply.id));
      if (previous !== null && (previous.sessionId !== id || JSON.stringify(previous.replies) !== JSON.stringify(originalRows) ||
        JSON.stringify(previous.placement) !== JSON.stringify(placement))) throw new Error(`Recovery inputs for BTW ${first.id} changed after backup`);
      let jsonl = events.map((event) => `${JSON.stringify(encodeEvent(event))}\n`).join("");
      let markdown = renderSessionMarkdown(projectSession(events));
      if (existing !== undefined) {
        if (originalJsonl === null) throw new Error(`Backup for existing conversation ${id} has no history`);
        const originalEvents = [...parseEvents(originalJsonl)];
        const metaIndex = originalEvents.findLastIndex((event) => event.type === "meta");
        originalEvents[metaIndex] = { ...originalEvents[metaIndex], origin };
        const indices = latestExchanges(originalEvents);
        for (const [index, reply] of thread.entries()) {
          const eventIndex = indices[index];
          const event = eventIndex === undefined ? undefined : originalEvents[eventIndex];
          if (event === undefined || eventIndex === undefined || (event.reply_id !== undefined && event.reply_id !== reply.id)) {
            throw new Error(`Saved turn for reply ${reply.id} already has another identity`);
          }
          originalEvents[eventIndex] = { ...event, reply_id: reply.id };
        }
        jsonl = originalEvents.map((event) => `${JSON.stringify(event)}\n`).join("");
        markdown = originalMarkdown ?? "";
      }
      const currentJsonl = yield* readOptional(owner, `sessions/${id}.jsonl`);
      const currentMarkdown = yield* readOptional(owner, `sessions/${id}.md`);
      if ((currentJsonl !== originalJsonl && currentJsonl !== jsonl) ||
        (currentMarkdown !== originalMarkdown && currentMarkdown !== markdown)) throw new Error(`Recovery destination ${id} contains changed history`);
      return { first, id, origin, owner, backupPath, backupText, jsonl, markdown, existing: existing !== undefined, updates,
        backup: { sessionId: id, session: previous?.session ?? existing?.raw ?? null, replies: originalRows, jsonl: originalJsonl, markdown: originalMarkdown, placement } };
    }));
    const summary = { mode: apply ? "applied" : "preview", threads: plans.length, created: plans.filter((plan) => !plan.existing).length,
      reused: plans.filter((plan) => plan.existing).length, replies: rows.length,
      paragraphAnchors: plans.filter((plan) => plan.backup.placement.quote_occurrences > 1).length };
    if (!apply) return summary;
    for (const plan of plans) {
      if (plan.backupText === null) yield* storage.writeText(plan.owner, plan.backupPath, JSON.stringify(plan.backup));
    }
    for (const plan of plans) {
      yield* storage.writeText(plan.owner, `sessions/${plan.id}.jsonl`, plan.jsonl);
      if (!plan.existing) yield* storage.writeText(plan.owner, `sessions/${plan.id}.md`, plan.markdown);
    }
    yield* sql.withTransaction(Effect.gen(function* () {
      for (const plan of plans) {
        if (!plan.existing) {
          const last = rows.find((row) => row.id === plan.updates.at(-1)!.id)!;
          yield* sql`INSERT INTO sessions (id, vault_id, user_id, query, origin, created_at, updated_at, idempotency_key)
            VALUES (${plan.id}, ${plan.first.vault_id}::uuid, ${plan.first.user_id}::uuid, ${plan.updates[0]!.request.question},
              ${JSON.stringify(plan.origin)}::jsonb, ${plan.first.created_at.toISOString()}::timestamptz,
              ${last.updated_at.toISOString()}::timestamptz, ${`recovered-btw:${plan.first.id}`})`;
        } else {
          const changed = yield* sql`UPDATE sessions SET origin = ${JSON.stringify(plan.origin)}::jsonb
            WHERE id = ${plan.id} AND vault_id = ${plan.first.vault_id}::uuid
              AND to_jsonb(sessions) = ${JSON.stringify(plan.backup.session)}::jsonb RETURNING id`;
          if (changed.length !== 1) throw new Error(`Saved conversation ${plan.id} changed during recovery`);
        }
        for (const update of plan.updates) {
          const changed = yield* sql`UPDATE replies SET session_id = ${plan.id}, kind = 'exchange', request = ${JSON.stringify(encodeRequest(update.request))}::jsonb
            WHERE id = ${update.id}::uuid AND to_jsonb(replies) = ${JSON.stringify(originals.get(update.id))}::jsonb RETURNING id`;
          if (changed.length !== 1) throw new Error(`Reply ${update.id} changed during recovery`);
        }
      }
    }));
    return summary;
  });

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const anchorsPath = process.argv[process.argv.indexOf("--anchors") + 1];
  if (!process.argv.includes("--anchors") || anchorsPath === undefined) throw new Error("Usage: recover-sessionless-replies.ts --anchors <placements.json> [--apply]");
  const placements = Schema.decodeUnknownSync(Schema.Array(AnchorPlacement))(JSON.parse(await readFile(anchorsPath, "utf8")));
  const base = Layer.mergeAll(PgClientLive, StructuredLoggerLive).pipe(Layer.provideMerge(AppConfigLive));
  const runtime = ManagedRuntime.make(StorageServicesLive.pipe(Layer.provideMerge(base)));
  try {
    console.log(JSON.stringify(await runtime.runPromise(recoverSessionlessReplies(placements, process.argv.includes("--apply")))));
  } finally {
    await runtime.dispose();
  }
}
