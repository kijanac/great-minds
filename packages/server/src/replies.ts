import { Database, replies, sessions as sessionsTable, vaults } from "@great-minds/database";
import {
  type BtwData,
  type CreateReplyRequest,
  CreateReplyRequest as CreateReplyRequestSchema,
  type CreateReplyResponse,
  type ExchangeData,
  Forbidden,
  NotFound,
  type QueryRequest,
  type QuerySourceData,
  type ReplySnapshot,
  ReplySnapshot as ReplySnapshotSchema,
  type ReplySource,
  type ReplySseEvent,
  ServiceUnavailable,
  type SessionId,
  SessionId as SessionIdSchema,
  type SessionOrigin,
  type Uuid,
  Uuid as UuidSchema,
} from "@great-minds/domain";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { Cause, Context, Effect, Layer, Option, Schema, Stream } from "effect";
import * as Activity from "effect/unstable/workflow/Activity";
import * as Workflow from "effect/unstable/workflow/Workflow";
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine";

import { ClockService } from "./clock.ts";
import { AppConfig } from "./config.ts";
import { StructuredLogger } from "./logging.ts";
import { type QueryPrecheckedContext, QueryService } from "./query.ts";
import { formatUuid7, RandomBytesService } from "./random.ts";
import { SessionsService } from "./sessions.ts";
import { VaultAccessService } from "./vaults.ts";

const terminalStatuses = new Set(["completed", "failed"]);
const sanitizedReplyError = "Something went wrong while answering. Try again in a minute.";
const flushIntervalMs = 125;

const decodeCreateReply = Schema.decodeUnknownEffect(CreateReplyRequestSchema);
const decodeReplySnapshot = Schema.decodeUnknownSync(ReplySnapshotSchema);
const decodeSessionId = Schema.decodeUnknownSync(SessionIdSchema);
const decodeUuid = Schema.decodeUnknownSync(UuidSchema);

const sse = (event: string, data: unknown): ReplySseEvent => ({
  event,
  data: typeof data === "string" ? data : JSON.stringify(data),
});

const replySseStream = <A>(events: AsyncIterable<A>) =>
  Stream.fromAsyncIterable(events, (cause) => cause).pipe(
    Stream.catch((cause) => Stream.fromEffect(Effect.die(cause))),
  );

const queryRequest = (input: CreateReplyRequest): QueryRequest => ({
  question:
    input.kind === "exchange" &&
    "create" in input &&
    input.create.origin !== undefined &&
    input.create.origin.anchor !== null
      ? composeAnchoredQuestion(input.create.origin, input.question)
      : input.question,
  mode: input.mode,
  history: input.history,
  ...(input.model === undefined ? {} : { model: input.model }),
  ...(input.origin_path === undefined ? {} : { origin_path: input.origin_path }),
  origin_scope: input.origin_scope,
  ...(input.extra_instructions === undefined
    ? {}
    : { extra_instructions: input.extra_instructions }),
});

// Mirrors web/src/lib/utils.ts buildBtwQuery: the surrounding paragraph first,
// then the highlighted quote (when distinct), then the user's clean question.
// Used only for the anchored first turn of a doc-born session; the session
// itself stores the clean question and the composed text never persists.
export const composeAnchoredQuestion = (origin: SessionOrigin, question: string): string => {
  const parts: string[] = [];
  if (origin.paragraph !== null && origin.paragraph.length > 0) {
    parts.push(`Passage:\n> ${origin.paragraph}`);
  }
  if (origin.anchor !== null && origin.anchor !== origin.paragraph) {
    parts.push(`Highlighted: "${origin.anchor}"`);
  }
  parts.push(question);
  return parts.join("\n\n");
};

const sourceRef = (data: QuerySourceData, thinking: string, pending = false): ReplySource => {
  if (data.type === "article" || data.type === "raw") {
    const isExpand = data.start !== undefined && data.end !== undefined;
    return {
      label: data.path,
      type: data.type,
      document_id: data.document_id,
      title: data.title,
      scope: null,
      path: null,
      thinking: thinking.length === 0 ? null : thinking,
      ranges: isExpand ? [{ start: data.start, end: data.end }] : [],
      full: !isExpand,
      pending: pending || undefined,
    };
  }
  if (data.type === "search") {
    return {
      label: data.query,
      type: "search",
      document_id: null,
      scope: data.scope,
      path: data.path ?? null,
      title: data.title,
      thinking: thinking.length === 0 ? null : thinking,
      pending: pending || undefined,
    };
  }
  if (data.type === "links") {
    return {
      label: data.path,
      type: "links",
      document_id: null,
      title: data.title,
      scope: null,
      path: null,
      thinking: thinking.length === 0 ? null : thinking,
      pending: pending || undefined,
    };
  }
  if (data.type === "query") {
    const summary =
      Object.entries(data.filters)
        .map(([key, value]) => `${key}: ${String(value)}`)
        .join(", ") || "filtered sources";
    return {
      label: summary,
      type: "query",
      document_id: null,
      title: null,
      scope: null,
      path: null,
      thinking: thinking.length === 0 ? null : thinking,
      pending: pending || undefined,
    };
  }
  throw new Error(`Unsupported query source: ${data.type}`);
};

export const ReplyWorkflow = Workflow.make("ReplyGeneration", {
  payload: { replyId: UuidSchema },
  idempotencyKey: ({ replyId }) => replyId,
  success: Schema.Void,
});

const dispatchReply = (
  replyId: Uuid,
  workflowEngine: WorkflowEngine.WorkflowEngine["Service"],
) =>
  Effect.gen(function* () {
    const db = yield* Database;
    yield* ReplyWorkflow.execute({ replyId }, { discard: true }).pipe(
      Effect.provideService(WorkflowEngine.WorkflowEngine, workflowEngine),
    );
    yield* db.query((d) => d
      .update(replies)
      .set({
        dispatchedAt: sql`coalesce(${replies.dispatchedAt}, now())`,
        dispatchedTaskId: replyId,
        updatedAt: sql`now()`,
      })
      .where(eq(replies.id, replyId)));
  });

type RepliesServiceShape = {
  readonly create: (
    userId: Uuid,
    vaultId: Uuid,
    input: CreateReplyRequest,
  ) => Effect.Effect<CreateReplyResponse, Forbidden | NotFound | ServiceUnavailable>;
  readonly stream: (
    userId: Uuid,
    vaultId: Uuid,
    replyId: Uuid,
  ) => Effect.Effect<Stream.Stream<ReplySseEvent>, Forbidden | NotFound>;
  readonly generate: (replyId: Uuid) => Effect.Effect<void>;
  readonly reconcileOnce: () => Effect.Effect<number>;
};

export class RepliesService extends Context.Service<RepliesService, RepliesServiceShape>()(
  "@great-minds/server/RepliesService",
) {}

export const RepliesServiceLive = Layer.effect(
  RepliesService,
  Effect.gen(function* () {
    const db = yield* Database;
    const access = yield* VaultAccessService;
    const clock = yield* ClockService;
    const config = yield* AppConfig;
    const logger = yield* StructuredLogger;
    const query = yield* QueryService;
    const randomBytes = yield* RandomBytesService;
    const sessions = yield* SessionsService;
    const workflowEngine = yield* WorkflowEngine.WorkflowEngine;
    const pollIntervalMs = Option.isSome(config.goldensClock) ? 1 : 100;

    const newReplyId = () =>
      Effect.gen(function* () {
        const now = yield* clock.now;
        const bytes = yield* randomBytes.bytes(16);
        return formatUuid7(now.getTime(), bytes);
      });

    const readReply = (vaultId: Uuid, replyId: Uuid) =>
      db.query((d) => d
        .select()
        .from(replies)
        .where(and(eq(replies.id, replyId), eq(replies.vaultId, vaultId)))
        .limit(1))
        .pipe(Effect.map((rows) => rows[0]));

    const readReplyById = (replyId: Uuid) =>
      db.query((d) => d
        .select()
        .from(replies)
        .where(eq(replies.id, replyId))
        .limit(1))
        .pipe(Effect.map((rows) => rows[0]));

    const requireSession = (vaultId: Uuid, sessionId: SessionId) =>
      db.query((d) => d
        .select({ id: sessionsTable.id })
        .from(sessionsTable)
        .where(and(eq(sessionsTable.vaultId, vaultId), eq(sessionsTable.id, sessionId)))
        .limit(1))
        .pipe(Effect.flatMap((rows) =>
        rows[0] === undefined
          ? Effect.fail(new NotFound({ detail: "Session not found" }))
          : Effect.void,
      ));

    const snapshot = (row: typeof replies.$inferSelect): ReplySnapshot =>
      decodeReplySnapshot({
        reply_id: row.id,
        session_id: row.sessionId,
        kind: row.kind,
        status: row.status,
        answer: row.answer,
        sources: row.sources,
        error: row.error,
        version: row.version,
        created_at: row.createdAt.toISOString(),
        updated_at: row.updatedAt.toISOString(),
      });

    const updateSnapshot = (
      replyId: Uuid,
      answer: string,
      sources: readonly ReplySource[],
    ) =>
      db.query((d) => d
        .update(replies)
        .set({
          answer,
          sources: [...sources],
          version: sql`${replies.version} + 1`,
          updatedAt: sql`now()`,
        })
        .where(and(eq(replies.id, replyId), eq(replies.status, "running"))))
        .pipe(Effect.asVoid);

    const markFailed = (
      replyId: Uuid,
      error: string,
      answer?: string,
      sources?: readonly ReplySource[],
    ) =>
      db.query((d) => d
        .update(replies)
        .set({
          status: "failed",
          error,
          ...(answer === undefined ? {} : { answer }),
          ...(sources === undefined ? {} : { sources: [...sources] }),
          version: sql`${replies.version} + 1`,
          updatedAt: sql`now()`,
        })
        .where(and(eq(replies.id, replyId), eq(replies.status, "running"))))
        .pipe(Effect.asVoid);

    const completeReply = (
      row: typeof replies.$inferSelect,
      input: CreateReplyRequest,
      answer: string,
      sources: readonly ReplySource[],
    ) =>
      Effect.gen(function* () {
        const settledSources = sources.filter((source) => source.pending !== true);
        const userId = decodeUuid(row.userId);
        const vaultId = decodeUuid(row.vaultId);
        const persistedReplyId = decodeUuid(row.id);
        if (input.kind === "exchange") {
          if (row.sessionId === null) {
            throw new Error(`Exchange reply ${row.id} is missing its session`);
          }
          const exchange: ExchangeData = {
            id: input.exchange_id,
            query: input.question,
            thinking: [{ sources: settledSources }],
            answer,
          };
          yield* sessions.appendExchange(
            userId,
            vaultId,
            decodeSessionId(row.sessionId),
            exchange,
            persistedReplyId,
          );
        } else if (input.kind === "btw") {
          if (row.sessionId === null) {
            throw new Error(`BTW reply ${row.id} is missing its session`);
          }
          const lastIndex = input.btw.exchanges.length - 1;
          const btw: BtwData = {
            ...input.btw,
            exchanges: input.btw.exchanges.map((exchange, index) =>
              index === lastIndex
                ? {
                    ...exchange,
                    thinking: settledSources.length === 0 ? [] : [{ sources: settledSources }],
                    answer,
                  }
                : exchange,
            ),
          };
          yield* sessions.appendBtw(
            userId,
            vaultId,
            decodeSessionId(row.sessionId),
            btw,
            persistedReplyId,
          );
        }

        yield* db.query((d) => d
          .update(replies)
          .set({
            status: "completed",
            answer,
            sources: settledSources,
            error: null,
            version: sql`${replies.version} + 1`,
            updatedAt: sql`now()`,
          })
          .where(and(eq(replies.id, row.id), eq(replies.status, "running"))));
      });

    const generate = (replyId: Uuid) =>
      Effect.gen(function* () {
        const row = yield* readReplyById(replyId);
        if (row === undefined || row.status !== "running") {
          return;
        }
        const input = yield* decodeCreateReply(row.request).pipe(Effect.orDie);
        const vaultRows = yield* db.query((d) => d
          .select({ name: vaults.name })
          .from(vaults)
          .where(eq(vaults.id, row.vaultId))
          .limit(1));
        const vault = vaultRows[0];
        if (vault === undefined) {
          yield* markFailed(replyId, sanitizedReplyError);
          return;
        }

        const prechecked: QueryPrecheckedContext = { vaultLabel: vault.name };
        const userId = decodeUuid(row.userId);
        const vaultId = decodeUuid(row.vaultId);
        const sources: ReplySource[] = [];
        const pendingCallIndexes = new Map<string, number | null>();
        let answer = "";
        let clearOnNextToken = false;
        let replacementSlot: number | undefined;
        let lastFlushAt = 0;

        const removeSource = (index: number) => {
          sources.splice(index, 1);
          for (const [callId, pendingIndex] of pendingCallIndexes) {
            if (pendingIndex !== null && pendingIndex > index) {
              pendingCallIndexes.set(callId, pendingIndex - 1);
            }
          }
        };

        const addResolvedSource = (data: QuerySourceData, pendingIndex?: number) => {
          if (data.type === "article" || data.type === "raw") {
            if (pendingIndex !== undefined) {
              removeSource(pendingIndex);
            }
            const isExpand = data.start !== undefined && data.end !== undefined;
            const range = isExpand ? { start: data.start, end: data.end } : null;
            const index = sources.findIndex(
              (source) =>
                source.label === data.path &&
                (source.type === "article" || source.type === "raw"),
            );
            if (index >= 0) {
              const previous = sources[index];
              sources[index] = {
                ...previous,
                ranges: range ? [...(previous.ranges ?? []), range] : previous.ranges,
                full: previous.full || !isExpand,
              };
            } else {
              sources.push(sourceRef(data, answer));
            }
            clearOnNextToken = true;
            return;
          }

          if (data.type === "links") {
            const existingIndex = sources.findIndex(
              (source, index) =>
                index !== pendingIndex && source.type === "links" && source.label === data.path,
            );
            if (existingIndex >= 0) {
              if (pendingIndex !== undefined) {
                removeSource(pendingIndex);
              }
              return;
            }
          }

          const resolved = sourceRef(data, answer);
          if (pendingIndex === undefined) {
            sources.push(resolved);
          } else {
            sources.splice(pendingIndex, 1, resolved);
          }
          clearOnNextToken = true;
        };

        const flush = () =>
          Effect.gen(function* () {
            yield* updateSnapshot(replyId, answer, sources);
            lastFlushAt = Date.now();
          });

        let terminal: "completed" | "failed" | null = null;
        let failureMessage = sanitizedReplyError;
        yield* Stream.fromAsyncIterable(
          query.streamEvents(
            userId,
            vaultId,
            queryRequest(input),
            prechecked,
          ),
          (cause) => cause,
        ).pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              if (replacementSlot !== undefined && event.event !== "source") {
                const pendingIndex = replacementSlot;
                replacementSlot = undefined;
                removeSource(pendingIndex);
              }

              if (event.event === "token") {
                if (clearOnNextToken) {
                  answer = "";
                  clearOnNextToken = false;
                }
                answer += event.data.text;
                if (Date.now() - lastFlushAt >= flushIntervalMs) {
                  yield* flush();
                }
              } else if (event.event === "source_pending") {
                const data = event.data.source;
                if (
                  (data.type === "article" || data.type === "raw") &&
                  sources.some(
                    (source) =>
                      source.label === data.path &&
                      (source.type === "article" || source.type === "raw"),
                  )
                ) {
                  pendingCallIndexes.set(event.data.call_id, null);
                } else {
                  pendingCallIndexes.set(event.data.call_id, sources.length);
                  sources.push(sourceRef(data, answer, true));
                  clearOnNextToken = true;
                }
                yield* flush();
              } else if (event.event === "source_settled") {
                const pendingIndex = pendingCallIndexes.get(event.data.call_id);
                pendingCallIndexes.delete(event.data.call_id);
                if (pendingIndex !== undefined && pendingIndex !== null) {
                  replacementSlot = pendingIndex;
                }
                yield* flush();
              } else if (event.event === "source") {
                const pendingIndex = replacementSlot;
                replacementSlot = undefined;
                addResolvedSource(event.data, pendingIndex);
                yield* flush();
              } else if (event.event === "done") {
                terminal = "completed";
              } else if (event.event === "error") {
                terminal = "failed";
                failureMessage = event.data.message;
              }
            }),
          ),
        );
        if (terminal === "completed") {
          yield* completeReply(row, input, answer, sources);
        } else {
          const settledSources = sources.filter((source) => source.pending !== true);
          yield* markFailed(replyId, failureMessage, answer, settledSources);
        }
      }).pipe(
        Effect.catchCause((cause) => {
          if (cause.reasons.length > 0 && cause.reasons.every(Cause.isInterruptReason)) {
            return Effect.interrupt;
          }
          return logger
            .error("reply_generation_failed", {
              reply_id: replyId,
              error_message: Cause.pretty(cause),
            })
            .pipe(Effect.andThen(markFailed(replyId, sanitizedReplyError)));
        }),
      );

    const dispatchBestEffort = (replyId: Uuid) =>
      dispatchReply(replyId, workflowEngine).pipe(
        Effect.provideService(Database, db),
        Effect.catchCause((cause) =>
          logger.warn("reply_dispatch_deferred", {
            reply_id: replyId,
            error_message: Cause.pretty(cause),
          }),
        ),
      );

    return {
      create: (userId, vaultId, input) =>
        Effect.gen(function* () {
          const vaultRows = yield* db.query((d) => d
            .select({ id: vaults.id })
            .from(vaults)
            .where(eq(vaults.id, vaultId))
            .limit(1));
          if (vaultRows[0] === undefined) {
            return yield* new NotFound({ detail: "Vault not found" });
          }
          yield* access.requireMember(userId, vaultId);
          if (Option.isNone(config.openRouterApiKey)) {
            return yield* new ServiceUnavailable({
              detail: "LLM service not configured (OPENROUTER_API_KEY missing)",
            });
          }

          const replyId = decodeUuid(yield* newReplyId());
          let sessionId: SessionId | null = null;
          if (input.kind === "exchange") {
            const pending: ExchangeData = {
              id: input.exchange_id,
              query: input.question,
              thinking: [],
              answer: "",
            };
            if ("session_id" in input) {
              sessionId = input.session_id;
              yield* requireSession(vaultId, sessionId);
              yield* sessions.appendExchange(userId, vaultId, sessionId, pending, replyId);
            } else {
              const created = yield* sessions.createSession(
                userId,
                vaultId,
                {
                  idempotency_key: input.create.idempotency_key,
                  exchange: pending,
                  ...(input.create.origin === undefined
                    ? {}
                    : {
                        origin: {
                          ...input.create.origin,
                          origin_scope: input.create.origin_scope,
                        },
                      }),
                },
                replyId,
              );
              sessionId = decodeSessionId(created.id);
            }
          } else if (input.kind === "btw") {
            sessionId = input.session_id;
            yield* requireSession(vaultId, sessionId);
            yield* sessions.appendBtw(userId, vaultId, sessionId, input.btw, replyId);
          }

          yield* db.query((d) => d
            .insert(replies)
            .values({
              id: replyId,
              vaultId,
              userId,
              sessionId,
              kind: input.kind,
              status: "running",
              answer: "",
              sources: [],
              request: input,
            }));
          yield* dispatchBestEffort(replyId);
          return { reply_id: replyId, session_id: sessionId };
        }),
      stream: (userId, vaultId, replyId) =>
        Effect.gen(function* () {
          yield* access.requireMember(userId, vaultId);
          const initial = yield* readReply(vaultId, replyId);
          if (initial === undefined) {
            return yield* new NotFound({ detail: "Reply not found" });
          }

          async function* events() {
            yield sse("connected", { id: replyId });
            let previousVersion = -1;
            let heartbeatAt = Date.now() + 30_000;
            while (true) {
              const row = await Effect.runPromise(readReply(vaultId, replyId));
              if (row !== undefined && row.version !== previousVersion) {
                previousVersion = row.version;
                const current = snapshot(row);
                yield sse("message", current);
                if (terminalStatuses.has(current.status)) {
                  yield sse("done", { id: replyId });
                  return;
                }
              }
              if (Date.now() >= heartbeatAt) {
                yield sse("message", "");
                heartbeatAt = Date.now() + 30_000;
              }
              await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
            }
          }

          return replySseStream(events());
        }),
      generate,
      reconcileOnce: () =>
        Effect.gen(function* () {
          const rows = yield* db.query((d) => d
            .select({ id: replies.id })
            .from(replies)
            .where(and(eq(replies.status, "running"), isNull(replies.dispatchedAt)))
            .orderBy(asc(replies.createdAt))
            .limit(100));
          yield* Effect.forEach(
            rows,
            (row) => dispatchBestEffort(row.id as Uuid),
            { concurrency: config.pipelineConcurrency },
          );
          return rows.length;
        }),
    } satisfies RepliesServiceShape;
  }),
);

export const ReplyWorkflowLive = ReplyWorkflow.toLayer((payload) =>
  Activity.make({
    name: "reply-generate",
    success: Schema.Void,
    execute: Effect.flatMap(RepliesService, (service) => service.generate(payload.replyId)),
  }),
);

export const ReplyReconcilerLoopLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const replies = yield* RepliesService;
    const logger = yield* StructuredLogger;
    const tick = replies.reconcileOnce().pipe(
      Effect.catchCause((cause) =>
        logger.warn("reply_reconciler_tick_failed", {
          error_message: Cause.pretty(cause),
        }),
      ),
    );
    yield* tick;
    yield* Effect.forkScoped(
      Effect.forever(Effect.sleep("5 seconds").pipe(Effect.andThen(tick))),
    );
  }),
);
