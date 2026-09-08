import { type Database, prompts } from "@great-minds/database";
import { Context, Data, Effect, Layer, Schedule, Schema } from "effect";

import { AppConfig, optionalRedactedValue } from "./config.ts";

export const recordPrompt = (db: Database["Service"], hash: string, content: string) =>
  db.query((d) => d.insert(prompts).values({ hash, content }).onConflictDoNothing());

type CostLookupShape = {
  readonly lookupGenerationCost: (
    generationId: string,
  ) => Effect.Effect<number | null, unknown>;
};

export class CostLookupService extends Context.Service<CostLookupService, CostLookupShape>()(
  "@great-minds/server/CostLookupService",
) {}

class RetryableGenerationStatus extends Data.TaggedError("RetryableGenerationStatus")<{
  readonly status: number;
}> {}

const retryableStatuses = new Set([404, 408, 409, 425, 429, 500, 502, 503, 504]);

const GenerationCost = Schema.Struct({
  data: Schema.Struct({ total_cost: Schema.Number }),
});
const decodeGenerationCost = Schema.decodeUnknownEffect(GenerationCost);

export const CostLookupLive = Layer.effect(
  CostLookupService,
  Effect.map(AppConfig, (config) => {
    const apiKey = optionalRedactedValue(config.openRouterApiKey);
    return {
      lookupGenerationCost: (generationId) => {
        if (apiKey === undefined || generationId.length === 0) {
          return Effect.succeed(null);
        }
        const url = `${config.openRouterApiUrl.replace(/\/$/, "")}/generation?id=${encodeURIComponent(
          generationId,
        )}`;
        return Effect.gen(function* () {
          const response = yield* Effect.tryPromise({
            try: (signal) => fetch(url, {
              method: "GET",
              headers: { authorization: `Bearer ${apiKey}` },
              signal,
            }),
            catch: (error) => error,
          });
          if (response.ok) {
            const json = yield* Effect.tryPromise({
              try: () => response.json(),
              catch: (error) => error,
            });
            const body = yield* decodeGenerationCost(json);
            return body.data.total_cost;
          }
          if (retryableStatuses.has(response.status)) {
            return yield* new RetryableGenerationStatus({ status: response.status });
          }
          return null;
        }).pipe(
          Effect.retry({
            schedule: Schedule.exponential("100 millis"),
            times: 4,
            while: (error) => error instanceof RetryableGenerationStatus,
          }),
          Effect.catchIf(
            (error) => error instanceof RetryableGenerationStatus,
            () => Effect.succeed(null),
          ),
        );
      },
    } satisfies CostLookupShape;
  }),
);
