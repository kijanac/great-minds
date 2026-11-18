import { isDeepStrictEqual } from "node:util";

import { Database, replies, sessions } from "@great-minds/database";
import {
  BadRequest,
  Conflict,
  CreateReplyRequest,
  type CreateReplyResponse,
  type Forbidden,
  NotFound,
  QueryMode,
  ServiceUnavailable,
  SessionActivity,
  SessionId,
  Uuid,
} from "@great-minds/domain";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Context, Data, Effect, Layer, Result, Schema } from "effect";

import { ClockService } from "../clock.ts";
import { AppConfig, missingModelKey, notConfiguredDetail } from "../config.ts";
import { formatUuid7, RandomBytesService } from "../random.ts";
import { VaultAccessService } from "../vaults.ts";
import {
  type ConversationHistory,
  hasUsableAnswer,
  planHistoryAppend,
  verifyHistoryReceipt,
} from "./history.ts";
import {
  acknowledgedReceipt,
  lockReplyOperation,
  readReplyOperation,
  type ReplyRow,
  type SessionRow,
  sessionReceipt,
} from "./rows.ts";
import { HistoryAttemptWrite, HistoryHeaderWrite, HistoryTimestamp } from "./schema.ts";
import { type HistoryCommitError, HistoryStore, type HistoryStoreShape } from "./store.ts";

const NewConversation = Schema.Struct({
  created_at: HistoryTimestamp,
  anchor_reply_id: HistoryHeaderWrite.fields.anchor_reply_id,
  context: HistoryHeaderWrite.fields.context,
});
type NewConversation = typeof NewConversation.Type;

export const AcceptedReplyRequest = Schema.Struct({
  command: Schema.toType(CreateReplyRequest),
  mode: QueryMode,
  accepted_at: HistoryTimestamp,
  previous_attempt_id: Schema.NullOr(Uuid),
  parent_reply_id: Schema.NullOr(Uuid),
  conversation: Schema.NullOr(NewConversation),
});
export type AcceptedReplyRequest = typeof AcceptedReplyRequest.Type;

export class ReplyAdmissionInvalid extends Data.TaggedError("ReplyAdmissionInvalid")<{
  readonly reply_id: Uuid;
  readonly reason: "request_payload" | "settled_attempt";
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
      missingModelKey(config, config.queryModel),
    );
  }),
);

type NewSession = Extract<CreateReplyRequest["session"], { kind: "new" }>;
type Target =
  | { readonly kind: "new"; readonly session: NewSession; readonly conversation: NewConversation }
  | { readonly kind: "existing"; readonly row: SessionRow; readonly history: ConversationHistory };

const liveStatuses = SessionActivity.fields.status.literals;
const decodeRequest = Schema.decodeUnknownEffect(AcceptedReplyRequest, {
  onExcessProperty: "error",
});
const encodeRequest = Schema.encodeSync(AcceptedReplyRequest, { onExcessProperty: "error" });

export const acceptedRequestFor = (row: Pick<ReplyRow, "id" | "request">) =>
  decodeRequest(row.request).pipe(
    Effect.mapError(
      () => new ReplyAdmissionInvalid({ reply_id: row.id, reason: "request_payload" }),
    ),
  );

export const acceptedWrites = (
  row: Pick<ReplyRow, "id" | "userId" | "sessionId">,
  request: AcceptedReplyRequest,
): readonly [HistoryAttemptWrite] | readonly [HistoryHeaderWrite, HistoryAttemptWrite] => {
  const { command, conversation } = request;
  const attempt: HistoryAttemptWrite = {
    type: "attempt",
    reply_id: row.id,
    exchange_id: command.exchange_id,
    previous_attempt_id: request.previous_attempt_id,
    parent_reply_id: request.parent_reply_id,
    question: command.question,
    accepted_at: request.accepted_at,
  };
  if (conversation === null) return [attempt];
  return [
    {
      type: "conversation",
      format: "great-minds/conversation",
      version: 1,
      session_id: row.sessionId,
      created_at: conversation.created_at,
      author_id: row.userId,
      origin: command.session.kind === "new" ? (command.session.origin ?? null) : null,
      anchor_reply_id: conversation.anchor_reply_id,
      context: conversation.context,
    },
    attempt,
  ];
};

const responseFor = (row: ReplyRow): CreateReplyResponse => ({
  reply_id: row.id,
  session_id: row.sessionId,
});

const contextParentFor = (history: ConversationHistory) =>
  Effect.gen(function* () {
    const latest = history.turns.findLast((turn) => hasUsableAnswer(turn.latest))?.latest;
    if (latest === undefined) return null;
    if (latest.settlement?.context_messages === null) {
      return yield* new BadRequest({
        detail: "The previous reply has no recorded model context",
      });
    }
    return latest.accepted.reply_id;
  });

export const makeReplyAdmission = (
  db: Database["Service"],
  histories: HistoryStoreShape,
  clock: ClockService["Service"],
  random: RandomBytesService["Service"],
  access: VaultAccessService["Service"],
  missingKey: string | undefined,
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
        (previousReplyId !== null && saved.previous_attempt_id !== previousReplyId)
      ) {
        return yield* new Conflict({ detail: "Reply id already belongs to another request" });
      }
      return responseFor(row);
    });

  const readHistory = (row: SessionRow) =>
    Effect.gen(function* () {
      const receipt = yield* acknowledgedReceipt(row);
      const stored = yield* histories.read({ vault_id: row.vaultId, session_id: row.id }, receipt);
      if (stored.history.revision.last_seq !== receipt.last_seq) {
        return yield* new Conflict({ detail: "Conversation history is awaiting reconciliation" });
      }
      return stored.history;
    });

  const newConversation = (userId: Uuid, vaultId: Uuid, session: NewSession) =>
    Effect.gen(function* () {
      const origin = session.origin ?? null;
      let context: NewConversation["context"] = null;
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
        const history = yield* readHistory(parent);
        const anchor = history.turns.find(
          (turn) => turn.exchange_id === origin.exchange_id,
        )?.latest;
        if (!hasUsableAnswer(anchor)) {
          return yield* new BadRequest({ detail: "Select a completed answer to start a BTW" });
        }
        anchorReplyId = anchor.accepted.reply_id;
        const parentReplyId = yield* contextParentFor(history);
        if (parentReplyId !== null) context = { session_id: parent.id, reply_id: parentReplyId };
      }
      return {
        created_at: HistoryTimestamp.make((yield* clock.now).toISOString()),
        anchor_reply_id: anchorReplyId,
        context,
      } satisfies NewConversation;
    });

  const reserve = (
    userId: Uuid,
    vaultId: Uuid,
    command: CreateReplyRequest,
    previousReplyId: Uuid | null = null,
  ) =>
    Effect.gen(function* () {
      yield* access.requireMember(userId, vaultId);
      const existingReply = yield* readReply(command.reply_id);
      if (existingReply !== undefined)
        return yield* replay(existingReply, userId, vaultId, command, previousReplyId);
      if (missingKey !== undefined) {
        return yield* new ServiceUnavailable({ detail: notConfiguredDetail(missingKey) });
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
        const conversation = yield* newConversation(userId, vaultId, destination);
        target = { kind: "new", session: destination, conversation };
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
        if (live !== undefined)
          return yield* new Conflict({ detail: "Conversation already has a live reply" });
        const history = yield* readHistory(existingSession);
        if (history.turns.some((turn) => turn.latest.settlement === null)) {
          return yield* new Conflict({ detail: "Conversation history is awaiting reconciliation" });
        }
        target = { kind: "existing", row: existingSession, history };
      }

      return yield* db.transaction((tx) =>
        Effect.gen(function* () {
          let sessionId: SessionId;
          if (target.kind === "new") {
            const createdAt = new Date(target.conversation.created_at);
            const [created] = yield* tx
              .insert(sessions)
              .values({
                id: SessionId.make(formatUuid7(createdAt.getTime(), yield* random.bytes(16)), {
                  disableChecks: true,
                }),
                vaultId,
                userId,
                query: command.question,
                origin: target.session.origin ?? null,
                createdAt,
                updatedAt: createdAt,
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
            sessionReceipt(session)?.sha256 !== target.history.revision.sha256
          ) {
            return yield* new Conflict({
              detail:
                "Conversation changed while accepting the reply; submit the same request again",
            });
          }
          const history = target.kind === "existing" ? target.history : null;
          const turn = history?.turns.find((entry) => entry.exchange_id === command.exchange_id);
          const previous = turn?.latest;
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
            command,
            mode: command.inline === true ? "btw" : "query",
            accepted_at: HistoryTimestamp.make(now.toISOString()),
            previous_attempt_id: previousReplyId,
            parent_reply_id: parentReplyId,
            conversation: target.kind === "new" ? target.conversation : null,
          } satisfies AcceptedReplyRequest;
          const planned = planHistoryAppend(
            session.id,
            history,
            acceptedWrites({ id: command.reply_id, userId, sessionId: session.id }, request),
          );
          if (Result.isFailure(planned)) return yield* planned.failure;
          const [inserted] = yield* tx
            .insert(replies)
            .values({
              id: command.reply_id,
              vaultId,
              userId,
              sessionId: session.id,
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
      const initial = yield* readReplyOperation(db, replyId);
      if (initial === undefined || initial.reply.status !== "admitting") return false;
      const request = yield* acceptedRequestFor(initial.reply);
      const committed = yield* histories.commit(
        { vault_id: initial.reply.vaultId, session_id: initial.reply.sessionId },
        acceptedWrites(initial.reply, request),
        request.conversation === null
          ? yield* acknowledgedReceipt(initial.session)
          : sessionReceipt(initial.session),
      );
      return yield* db.transaction((tx) =>
        Effect.gen(function* () {
          const locked = yield* lockReplyOperation(tx, initial.reply);
          if (locked === null || locked.reply.status !== "admitting") return false;
          const { session } = locked;
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
          const receipt = sessionReceipt(session);
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
              updatedAt: sql`greatest(${sessions.updatedAt}, ${new Date(request.accepted_at)})`,
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

  return { reserve, admit, accept, retry };
};
