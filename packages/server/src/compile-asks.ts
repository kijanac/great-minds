import { compileCacheEntries, type Database, llmCostEvents, vaults } from "@great-minds/database";
import type { Uuid } from "@great-minds/domain";
import { and, eq, sql } from "drizzle-orm";
import { Effect, Schema } from "effect";

import type { ReasoningEffort } from "./config.ts";
import { contentHash } from "./crypto.ts";
import { errorDetails } from "./error-details.ts";
import { type LanguageModel, type LlmMessage, stripJsonFence } from "./llm.ts";
import type { StructuredLogger } from "./logging.ts";

export type AskRequest<A, I> = {
  readonly kind: string;
  readonly model: string;
  readonly messages: readonly LlmMessage[];
  readonly temperature?: number;
  readonly reasoningEffort?: ReasoningEffort;
  readonly responseFormat: Record<string, unknown>;
  readonly answer: Schema.Codec<A, I>;
};

export class AskFailed extends Schema.TaggedError<AskFailed>()("AskFailed", {
  kind: Schema.String,
  reason: Schema.Literals(["provider", "truncated", "malformed"] as const),
  message: Schema.String,
}) {}

export type Progress = (step: string, done: number, total: number) => Effect.Effect<void>;

export type AskRunner = {
  readonly ask: <A, I>(request: AskRequest<A, I>) => Effect.Effect<A, AskFailed>;
  readonly preloadKind: (kind: string) => Effect.Effect<void>;
  readonly recall: <A, I>(
    kind: string,
    key: string,
    codec: Schema.Codec<A, I>,
  ) => Effect.Effect<A | undefined>;
  readonly keep: <A, I>(
    kind: string,
    key: string,
    codec: Schema.Codec<A, I>,
    value: A,
  ) => Effect.Effect<void>;
};

export const askKey = (request: AskRequest<unknown, unknown>) =>
  contentHash(
    JSON.stringify({
      model: request.model,
      messages: request.messages,
      temperature: request.temperature ?? null,
      reasoningEffort: request.reasoningEffort ?? null,
      responseFormat: request.responseFormat,
    }),
  );

export const makeAskRunner = (
  dependencies: {
    readonly db: Database["Service"];
    readonly languageModel: LanguageModel["Service"];
    readonly logger: StructuredLogger["Service"];
  },
  scope: { readonly vaultId: Uuid; readonly runId: Uuid },
) =>
  Effect.gen(function* () {
    const { db, languageModel, logger } = dependencies;
    const loaded = new Map<string, unknown>();

    const preloadKind = (kind: string) =>
      Effect.gen(function* () {
        const phase = `ask:${kind}`;
        const rows = yield* db.query((d) =>
          d
            .select({ cacheKey: compileCacheEntries.cacheKey, value: compileCacheEntries.value })
            .from(compileCacheEntries)
            .where(
              and(
                eq(compileCacheEntries.vaultId, scope.vaultId),
                eq(compileCacheEntries.phase, phase),
              ),
            ),
        );
        for (const row of rows) loaded.set(`${phase}\u0000${row.cacheKey}`, row.value);
      });

    const decodeSaved = <A, I>(
      phase: string,
      key: string,
      answer: Schema.Codec<A, I>,
      value: unknown,
    ) =>
      Schema.decodeUnknownEffect(answer)(value).pipe(
        Effect.catchTag("SchemaError", (error) =>
          Effect.gen(function* () {
            loaded.delete(`${phase}\u0000${key}`);
            yield* logger.warn("compile_cache.malformed", {
              vault_id: scope.vaultId,
              run_id: scope.runId,
              phase,
              cache_key: key,
              error: error.message,
            });
            yield* db.query((d) =>
              d
                .delete(compileCacheEntries)
                .where(
                  and(
                    eq(compileCacheEntries.vaultId, scope.vaultId),
                    eq(compileCacheEntries.phase, phase),
                    eq(compileCacheEntries.cacheKey, key),
                  ),
                ),
            );
            return undefined;
          }),
        ),
      );

    const saved = <A, I>(phase: string, key: string, answer: Schema.Codec<A, I>) =>
      Effect.gen(function* () {
        const preloaded = loaded.get(`${phase}\u0000${key}`);
        if (preloaded !== undefined) return yield* decodeSaved(phase, key, answer, preloaded);
        const [row] = yield* db.query((d) =>
          d
            .select({ value: compileCacheEntries.value })
            .from(compileCacheEntries)
            .where(
              and(
                eq(compileCacheEntries.vaultId, scope.vaultId),
                eq(compileCacheEntries.phase, phase),
                eq(compileCacheEntries.cacheKey, key),
              ),
            )
            .limit(1),
        );
        if (row === undefined) return undefined;
        return yield* decodeSaved(phase, key, answer, row.value);
      });

    const keep = <A, I>(kind: string, key: string, codec: Schema.Codec<A, I>, value: A) =>
      Effect.gen(function* () {
        const encoded = yield* Schema.encodeEffect(codec)(value).pipe(Effect.orDie);
        yield* db.query((d) =>
          d
            .insert(compileCacheEntries)
            .values({ vaultId: scope.vaultId, phase: `ask:${kind}`, cacheKey: key, value: encoded })
            .onConflictDoNothing(),
        );
      });

    const ask = <A, I>(request: AskRequest<A, I>) =>
      Effect.gen(function* () {
        const phase = `ask:${request.kind}`;
        const key = askKey(request);
        const reused = yield* saved(phase, key, request.answer);
        if (reused !== undefined) return reused;
        const completion = yield* languageModel
          .complete({
            model: request.model,
            messages: request.messages,
            temperature: request.temperature,
            reasoningEffort: request.reasoningEffort,
            responseFormat: request.responseFormat,
            requestProfile: "compile",
          })
          .pipe(
            Effect.mapError(
              (error) =>
                new AskFailed({
                  kind: request.kind,
                  reason: "provider",
                  message: errorDetails(error).message,
                }),
            ),
          );
        const cost = completion.usage?.cost ?? 0;
        yield* db.query((d) =>
          d.insert(llmCostEvents).values({
            userId: sql`(select ${vaults.ownerId} from ${vaults} where ${vaults.id} = ${scope.vaultId})`,
            vaultId: scope.vaultId,
            eventType: "compile",
            phase,
            model: request.model,
            promptHash: key,
            runId: scope.runId,
            correlationId: `compile-${scope.runId}`,
            promptTokens: completion.usage?.promptTokens ?? null,
            completionTokens: completion.usage?.completionTokens ?? null,
            costUsd: cost.toFixed(6),
            generationId: completion.generationId ?? null,
          }),
        );
        if (completion.finishReason === "length")
          return yield* new AskFailed({
            kind: request.kind,
            reason: "truncated",
            message: `${request.model} stopped at its output limit`,
          });
        const answer = yield* Schema.decodeEffect(Schema.fromJsonString(request.answer))(
          stripJsonFence(completion.text.trim()),
        ).pipe(
          Effect.mapError(
            (error) =>
              new AskFailed({ kind: request.kind, reason: "malformed", message: error.message }),
          ),
        );
        yield* keep(request.kind, key, request.answer, answer);
        return answer;
      }).pipe(
        Effect.tapError((error) =>
          error._tag === "AskFailed"
            ? logger.warn("ask_failed", {
                vault_id: scope.vaultId,
                run_id: scope.runId,
                kind: error.kind,
                reason: error.reason,
                error: error.message,
              })
            : Effect.void,
        ),
      );

    return {
      ask,
      preloadKind,
      recall: (kind, key, codec) => saved(`ask:${kind}`, key, codec),
      keep,
    } satisfies AskRunner;
  });
