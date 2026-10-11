import { isDeepStrictEqual } from "node:util";

import { Database, replies, sessions, vaults } from "@great-minds/database";
import {
  BadRequest,
  Conflict,
  CreateReplyRequest,
  type CreateReplyResponse,
  type Forbidden,
  NotFound,
  ServiceUnavailable,
  SessionId,
  type Uuid,
} from "@great-minds/domain";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Context, Data, Effect, Layer, Option, Result, Schema } from "effect";

import { ClockService } from "../clock.ts";
import { AppConfig } from "../config.ts";
import { formatUuid7, RandomBytesService } from "../random.ts";
import { VaultAccessService } from "../vaults.ts";
import {
  type ConversationHistory,
  HistoryInvalid,
  type HistoryRevision,
  planHistoryAppend,
  verifyHistoryReceipt,
} from "./history.ts";
import { HistoryAttemptWrite, HistoryHeaderWrite, HistoryTimestamp } from "./schema.ts";
import { type HistoryCommitError, HistoryStore, type HistoryStoreShape } from "./store.ts";

export const AcceptedReplyRequest = Schema.Struct({
  version: Schema.Literal(1),
  command: Schema.toType(CreateReplyRequest),
  mode: Schema.Literals(["btw", "query"]),
  header: Schema.NullOr(HistoryHeaderWrite),
  attempt: Schema.Struct({ ...HistoryAttemptWrite.fields, accepted_at: HistoryTimestamp }),
});
export type AcceptedReplyRequest = typeof AcceptedReplyRequest.Type;

export class ReplyAdmissionInvalid extends Data.TaggedError("ReplyAdmissionInvalid")<{
  readonly reply_id: Uuid;
  readonly reason: "request_payload" | "request_identity" | "settled_attempt";
}> {}

export type ReplyAdmissionError =
  | BadRequest
  | Conflict
  | Forbidden
  | NotFound
  | ServiceUnavailable
  | ReplyAdmissionInvalid
  | HistoryCommitError;

export interface ReplyAdmissionShape {
  readonly reserve: (
    userId: Uuid,
    vaultId: Uuid,
    input: CreateReplyRequest,
  ) => Effect.Effect<CreateReplyResponse, ReplyAdmissionError>;
  readonly admit: (
    replyId: Uuid,
  ) => Effect.Effect<boolean, ReplyAdmissionInvalid | HistoryCommitError>;
  readonly accept: (
    userId: Uuid,
    vaultId: Uuid,
    input: CreateReplyRequest,
  ) => Effect.Effect<CreateReplyResponse, ReplyAdmissionError>;
  readonly retry: (
    userId: Uuid,
    vaultId: Uuid,
    previousReplyId: Uuid,
    nextReplyId: Uuid,
  ) => Effect.Effect<CreateReplyResponse, ReplyAdmissionError>;
}

export class ReplyAdmission extends Context.Service<ReplyAdmission, ReplyAdmissionShape>()(
  "@great-minds/server/ReplyAdmission",
) {}

export const ReplyAdmissionLive = Layer.effect(
  ReplyAdmission,
  Effect.gen(function* () {
    const db = yield* Database;
    const histories = yield* HistoryStore;
    const clock = yield* ClockService;
    const random = yield* RandomBytesService;
    const access = yield* VaultAccessService;
    const config = yield* AppConfig;
    return makeReplyAdmission(
      db,
      histories,
      clock,
      random,
      access,
      Option.isSome(config.openRouterApiKey),
    );
  }),
);

type SessionRow = typeof sessions.$inferSelect;
type ReplyRow = typeof replies.$inferSelect;
type Target =
  | {
      readonly kind: "new";
      readonly session: Extract<CreateReplyRequest["session"], { kind: "new" }>;
      readonly header: HistoryHeaderWrite;
    }
  | { readonly kind: "existing"; readonly row: SessionRow; readonly history: ConversationHistory };

const liveStatuses = ["admitting", "running", "settling"] as const;
const decodeRequest = Schema.decodeUnknownEffect(AcceptedReplyRequest, {
  onExcessProperty: "error",
});
const encodeRequest = Schema.encodeSync(AcceptedReplyRequest, { onExcessProperty: "error" });

export const acceptedRequestFor = (row: ReplyRow) =>
  Effect.gen(function* () {
    const request = yield* decodeRequest(row.request).pipe(
      Effect.mapError(
        () => new ReplyAdmissionInvalid({ reply_id: row.id, reason: "request_payload" }),
      ),
    );
    if (
      request.command.reply_id !== row.id ||
      request.attempt.reply_id !== row.id ||
      request.command.exchange_id !== request.attempt.exchange_id ||
      request.command.question !== request.attempt.question ||
      (request.command.session.kind === "existing" &&
        request.command.session.id !== row.sessionId) ||
      (request.header !== null &&
        (request.header.session_id !== row.sessionId ||
          request.header.author_id !== row.userId ||
          request.command.session.kind !== "new" ||
          !isDeepStrictEqual(request.header.origin, request.command.session.origin ?? null) ||
          request.attempt.parent_reply_id !== null ||
          request.attempt.previous_attempt_id !== null))
    ) {
      return yield* new ReplyAdmissionInvalid({ reply_id: row.id, reason: "request_identity" });
    }
    return request;
  });

const receiptFor = (session: SessionRow): HistoryRevision | undefined =>
  session.historySeq === null || session.historySha256 === null
    ? undefined
    : { last_seq: session.historySeq, sha256: session.historySha256 };

const responseFor = (row: ReplyRow): CreateReplyResponse => ({
  reply_id: row.id,
  session_id: row.sessionId,
});

const contextParentFor = (history: ConversationHistory) =>
  Effect.gen(function* () {
    for (let index = history.turns.length - 1; index >= 0; index -= 1) {
      const { accepted, settlement } = history.turns[index].attempts.at(-1)!;
      if (settlement === null || settlement.outcome.status === "failed") continue;
      if (settlement.context_messages === null) {
        return yield* new BadRequest({
          detail: "The previous reply has no recorded model context",
        });
      }
      return accepted.reply_id;
    }
    return null;
  });

export const makeReplyAdmission = (
  db: Database["Service"],
  histories: HistoryStoreShape,
  clock: ClockService["Service"],
  random: RandomBytesService["Service"],
  access: VaultAccessService["Service"],
  generationConfigured: boolean,
) => {
  const readReply = (replyId: Uuid) =>
    db
      .query((client) => client.select().from(replies).where(eq(replies.id, replyId)).limit(1))
      .pipe(Effect.map((rows) => rows[0]));

  const replay = (
    row: ReplyRow,
    userId: Uuid,
    vaultId: Uuid,
    input: CreateReplyRequest,
    previousReplyId: Uuid | null,
  ) =>
    Effect.gen(function* () {
      if (row.userId !== userId || row.vaultId !== vaultId) {
        return yield* new Conflict({ detail: "Reply id already belongs to another request" });
      }
      const saved = yield* acceptedRequestFor(row);
      if (
        !isDeepStrictEqual(saved.command, input) ||
        saved.attempt.previous_attempt_id !== previousReplyId
      ) {
        return yield* new Conflict({ detail: "Reply id already belongs to another request" });
      }
      return responseFor(row);
    });

  const readHistory = (row: SessionRow) =>
    Effect.gen(function* () {
      const receipt = receiptFor(row);
      if (receipt === undefined) {
        return yield* new HistoryInvalid({
          session_id: row.id,
          line: null,
          reason: "history_receipt",
        });
      }
      const stored = yield* histories.read({ vault_id: row.vaultId, session_id: row.id }, receipt);
      if (stored === null) {
        return yield* new HistoryInvalid({
          session_id: row.id,
          line: null,
          reason: "history_receipt",
        });
      }
      if (!isDeepStrictEqual(stored.history.revision, receipt)) {
        return yield* new Conflict({ detail: "Conversation history is awaiting reconciliation" });
      }
      return stored.history;
    });

  const newHeader = (
    userId: Uuid,
    vaultId: Uuid,
    session: Extract<CreateReplyRequest["session"], { kind: "new" }>,
  ) =>
    Effect.gen(function* () {
      const origin = session.origin ?? null;
      if (session.conversation_kind === "btw" && !origin?.anchor) {
        return yield* new BadRequest({ detail: "A BTW needs a selected passage" });
      }
      let context: HistoryHeaderWrite["context"] = null;
      let anchorReplyId: Uuid | null = null;
      if (origin?.kind === "answer") {
        const [parent] = yield* db.query((client) =>
          client
            .select()
            .from(sessions)
            .where(and(eq(sessions.id, origin.session_id), eq(sessions.vaultId, vaultId)))
            .limit(1),
        );
        if (parent === undefined || parent.userId !== userId) {
          return yield* new NotFound({ detail: "Session not found" });
        }
        if (parent.placement !== "standalone") {
          return yield* new BadRequest({ detail: "Nested BTWs aren't supported" });
        }
        const history = yield* readHistory(parent);
        const anchor = history.turns
          .find((turn) => turn.exchange_id === origin.exchange_id)
          ?.attempts.at(-1);
        if (
          anchor?.settlement === undefined ||
          anchor.settlement === null ||
          anchor.settlement.outcome.status === "failed"
        ) {
          return yield* new BadRequest({ detail: "Select a completed answer to start a BTW" });
        }
        anchorReplyId = anchor.accepted.reply_id;
        const parentReplyId = yield* contextParentFor(history);
        if (parentReplyId !== null) context = { session_id: parent.id, reply_id: parentReplyId };
      }
      const now = yield* clock.now;
      const bytes = yield* random.bytes(16);
      const id = SessionId.make(formatUuid7(now.getTime(), bytes), { disableChecks: true });
      return {
        type: "conversation",
        format: "great-minds/conversation",
        version: 1,
        session_id: id,
        created_at: HistoryTimestamp.make(now.toISOString()),
        author_id: userId,
        origin,
        anchor_reply_id: anchorReplyId,
        context,
      } satisfies HistoryHeaderWrite;
    });

  const reserve = (
    userId: Uuid,
    vaultId: Uuid,
    input: CreateReplyRequest,
    previousReplyId: Uuid | null = null,
  ) =>
    Effect.gen(function* () {
      const command = structuredClone(input);
      const [vault] = yield* db.query((client) =>
        client.select({ id: vaults.id }).from(vaults).where(eq(vaults.id, vaultId)).limit(1),
      );
      if (vault === undefined) return yield* new NotFound({ detail: "Vault not found" });
      yield* access.requireMember(userId, vaultId);
      const existingReply = yield* readReply(command.reply_id);
      if (existingReply !== undefined)
        return yield* replay(existingReply, userId, vaultId, command, previousReplyId);
      if (!generationConfigured) {
        return yield* new ServiceUnavailable({
          detail: "LLM service not configured (OPENROUTER_API_KEY missing)",
        });
      }
      const destination = command.session;
      const [existingSession] = yield* db.query((client) =>
        client
          .select()
          .from(sessions)
          .where(
            and(
              eq(sessions.vaultId, vaultId),
              destination.kind === "existing"
                ? eq(sessions.id, destination.id)
                : eq(sessions.idempotencyKey, destination.idempotency_key),
            ),
          )
          .limit(1),
      );
      let target: Target;
      if (existingSession === undefined) {
        if (destination.kind === "existing")
          return yield* new NotFound({ detail: "Session not found" });
        const header = yield* newHeader(userId, vaultId, destination);
        target = { kind: "new", session: destination, header };
      } else {
        if (existingSession.userId !== userId)
          return yield* new NotFound({ detail: "Session not found" });
        const [live] = yield* db.query((client) =>
          client
            .select()
            .from(replies)
            .where(
              and(
                eq(replies.sessionId, existingSession.id),
                eq(replies.vaultId, vaultId),
                inArray(replies.status, liveStatuses),
              ),
            )
            .limit(1),
        );
        if (live?.id === command.reply_id)
          return yield* replay(live, userId, vaultId, command, previousReplyId);
        if (live !== undefined)
          return yield* new Conflict({ detail: "Conversation already has a live reply" });
        const history = yield* readHistory(existingSession);
        if (
          history.turns.some((turn) => turn.attempts.some((attempt) => attempt.settlement === null))
        ) {
          return yield* new Conflict({ detail: "Conversation history is awaiting reconciliation" });
        }
        target = { kind: "existing", row: existingSession, history };
      }

      return yield* db.transaction((tx) =>
        Effect.gen(function* () {
          const [beforeLock] = yield* tx
            .select()
            .from(replies)
            .where(eq(replies.id, command.reply_id))
            .limit(1);
          if (beforeLock !== undefined)
            return yield* replay(beforeLock, userId, vaultId, command, previousReplyId);
          let sessionId: SessionId;
          if (target.kind === "new") {
            const [created] = yield* tx
              .insert(sessions)
              .values({
                id: target.header.session_id,
                vaultId,
                userId,
                query: command.question,
                origin: target.header.origin,
                placement: target.session.conversation_kind === "btw" ? "inline" : "standalone",
                replyMode: target.session.conversation_kind === "btw" ? "btw" : "query",
                createdAt: new Date(target.header.created_at),
                updatedAt: new Date(target.header.created_at),
                idempotencyKey: target.session.idempotency_key,
              })
              .onConflictDoNothing()
              .returning({ id: sessions.id });
            if (created === undefined) {
              const [concurrent] = yield* tx
                .select()
                .from(replies)
                .where(eq(replies.id, command.reply_id))
                .limit(1);
              if (concurrent !== undefined)
                return yield* replay(concurrent, userId, vaultId, command, previousReplyId);
              return yield* new Conflict({
                detail:
                  "Conversation changed while accepting the reply; submit the same request again",
              });
            }
            sessionId = created.id;
          } else {
            sessionId = target.row.id;
          }
          const [session] = yield* tx
            .select()
            .from(sessions)
            .where(and(eq(sessions.id, sessionId), eq(sessions.vaultId, vaultId)))
            .limit(1)
            .for("update");
          if (session === undefined || session.userId !== userId)
            return yield* new NotFound({ detail: "Session not found" });
          const [concurrent] = yield* tx
            .select()
            .from(replies)
            .where(eq(replies.id, command.reply_id))
            .limit(1);
          if (concurrent !== undefined)
            return yield* replay(concurrent, userId, vaultId, command, previousReplyId);
          const [live] = yield* tx
            .select({ id: replies.id })
            .from(replies)
            .where(
              and(
                eq(replies.sessionId, session.id),
                eq(replies.vaultId, vaultId),
                inArray(replies.status, liveStatuses),
              ),
            )
            .limit(1);
          if (live !== undefined)
            return yield* new Conflict({ detail: "Conversation already has a live reply" });
          if (
            target.kind === "existing" &&
            !isDeepStrictEqual(receiptFor(session), target.history.revision)
          ) {
            return yield* new Conflict({
              detail:
                "Conversation changed while accepting the reply; submit the same request again",
            });
          }
          const history = target.kind === "existing" ? target.history : null;
          const turn = history?.turns.find((entry) => entry.exchange_id === command.exchange_id);
          const previous = turn?.attempts.at(-1);
          if (previousReplyId === null && previous !== undefined) {
            return yield* new Conflict({
              detail: "Exchange already exists; use its retry operation",
            });
          }
          let parentReplyId: Uuid | null;
          if (previousReplyId !== null) {
            if (
              previous?.accepted.reply_id !== previousReplyId ||
              previous.settlement?.outcome.status !== "failed"
            ) {
              return yield* new Conflict({
                detail: "Only the selected failed attempt can be retried",
              });
            }
            parentReplyId = previous.accepted.parent_reply_id;
          } else {
            parentReplyId = history === null ? null : yield* contextParentFor(history);
          }
          const now = yield* clock.now;
          const request = {
            version: 1,
            command,
            mode: session.replyMode,
            header: target.kind === "new" ? target.header : null,
            attempt: {
              type: "attempt",
              reply_id: command.reply_id,
              exchange_id: command.exchange_id,
              previous_attempt_id: previousReplyId,
              parent_reply_id: parentReplyId,
              question: command.question,
              accepted_at: HistoryTimestamp.make(now.toISOString()),
            },
          } satisfies AcceptedReplyRequest;
          const planned = planHistoryAppend(
            session.id,
            history,
            request.header === null ? [request.attempt] : [request.header, request.attempt],
          );
          if (Result.isFailure(planned)) return yield* planned.failure;
          const [inserted] = yield* tx
            .insert(replies)
            .values({
              id: command.reply_id,
              vaultId,
              userId,
              sessionId: session.id,
              kind: "exchange",
              status: "admitting",
              request: encodeRequest(request),
              createdAt: now,
              updatedAt: now,
            })
            .onConflictDoNothing({ target: replies.id })
            .returning();
          if (inserted !== undefined) return responseFor(inserted);
          const [winner] = yield* tx
            .select()
            .from(replies)
            .where(eq(replies.id, command.reply_id))
            .limit(1);
          if (winner === undefined)
            return yield* Effect.die(new Error("Conflicting reply disappeared"));
          return yield* replay(winner, userId, vaultId, command, previousReplyId);
        }),
      );
    });

  const admit = (replyId: Uuid) =>
    Effect.gen(function* () {
      const [initial] = yield* db.query((client) =>
        client
          .select({ reply: replies, session: sessions })
          .from(replies)
          .innerJoin(
            sessions,
            and(eq(sessions.id, replies.sessionId), eq(sessions.vaultId, replies.vaultId)),
          )
          .where(eq(replies.id, replyId))
          .limit(1),
      );
      if (initial === undefined || initial.reply.status !== "admitting") return false;
      const request = yield* acceptedRequestFor(initial.reply);
      if (request.header === null && receiptFor(initial.session) === undefined) {
        return yield* new HistoryInvalid({
          session_id: initial.session.id,
          line: null,
          reason: "history_receipt",
        });
      }
      const committed = yield* histories.commit(
        { vault_id: initial.reply.vaultId, session_id: initial.reply.sessionId },
        request.header === null ? [request.attempt] : [request.header, request.attempt],
        receiptFor(initial.session),
      );
      return yield* db.transaction((tx) =>
        Effect.gen(function* () {
          const [session] = yield* tx
            .select()
            .from(sessions)
            .where(
              and(
                eq(sessions.id, initial.reply.sessionId),
                eq(sessions.vaultId, initial.reply.vaultId),
              ),
            )
            .limit(1)
            .for("update");
          if (session === undefined) return false;
          const [row] = yield* tx
            .select()
            .from(replies)
            .where(
              and(
                eq(replies.id, replyId),
                eq(replies.sessionId, session.id),
                eq(replies.vaultId, session.vaultId),
              ),
            )
            .limit(1)
            .for("update");
          if (row === undefined || row.status !== "admitting") return false;
          if (
            committed.history.records.some(
              (record) => record.type === "settlement" && record.reply_id === replyId,
            )
          ) {
            return yield* new ReplyAdmissionInvalid({
              reply_id: replyId,
              reason: "settled_attempt",
            });
          }
          const frozen = yield* acceptedRequestFor(row);
          if (!isDeepStrictEqual(frozen, request))
            return yield* new ReplyAdmissionInvalid({
              reply_id: replyId,
              reason: "request_payload",
            });
          const receipt = receiptFor(session);
          if (receipt !== undefined) {
            const verified = verifyHistoryReceipt(committed.history, receipt);
            if (Result.isFailure(verified)) return yield* verified.failure;
          }
          const now = yield* clock.now;
          yield* tx
            .update(sessions)
            .set({
              historySeq: committed.history.revision.last_seq,
              historySha256: committed.history.revision.sha256,
              updatedAt: sql`greatest(${sessions.updatedAt}, ${new Date(request.attempt.accepted_at)})`,
            })
            .where(and(eq(sessions.id, session.id), eq(sessions.vaultId, session.vaultId)));
          yield* tx
            .update(replies)
            .set({ status: "running", version: sql`${replies.version} + 1`, updatedAt: now })
            .where(eq(replies.id, replyId));
          return true;
        }),
      );
    });

  const confirm = (userId: Uuid, vaultId: Uuid, reserved: CreateReplyResponse) =>
    Effect.gen(function* () {
      if (!(yield* admit(reserved.reply_id))) {
        const current = yield* readReply(reserved.reply_id);
        if (
          current === undefined ||
          current.sessionId !== reserved.session_id ||
          current.vaultId !== vaultId ||
          current.userId !== userId
        ) {
          return yield* new NotFound({ detail: "Reply not found" });
        }
        if (current.status === "admitting") {
          return yield* new Conflict({ detail: "Reply admission is awaiting reconciliation" });
        }
      }
      return reserved;
    });

  const accept = (userId: Uuid, vaultId: Uuid, input: CreateReplyRequest) =>
    Effect.gen(function* () {
      return yield* confirm(userId, vaultId, yield* reserve(userId, vaultId, input));
    });

  const retry = (userId: Uuid, vaultId: Uuid, previousReplyId: Uuid, nextReplyId: Uuid) =>
    Effect.gen(function* () {
      yield* access.requireMember(userId, vaultId);
      const previous = yield* readReply(previousReplyId);
      if (previous === undefined || previous.userId !== userId || previous.vaultId !== vaultId)
        return yield* new NotFound({ detail: "Reply not found" });
      if (previous.status !== "failed")
        return yield* new BadRequest({ detail: "Only failed replies can be retried" });
      if (nextReplyId === previousReplyId)
        return yield* new BadRequest({ detail: "Retry requires a new reply id" });
      const saved = yield* acceptedRequestFor(previous);
      const reserved = yield* reserve(
        userId,
        vaultId,
        {
          ...saved.command,
          reply_id: nextReplyId,
          session: { kind: "existing", id: previous.sessionId },
        },
        previousReplyId,
      );
      return yield* confirm(userId, vaultId, reserved);
    });

  return {
    reserve: (userId: Uuid, vaultId: Uuid, input: CreateReplyRequest) =>
      reserve(userId, vaultId, input),
    admit,
    accept,
    retry,
  } satisfies ReplyAdmissionShape;
};
