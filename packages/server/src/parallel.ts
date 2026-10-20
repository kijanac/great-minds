import { Context, Data, Effect, Layer, Schema } from "effect";

import { AppConfig, optionalRedactedValue } from "./config.ts";

export type ParallelSearchResult = {
  readonly title: string;
  readonly url: string;
  readonly excerpts: readonly string[];
};

type ParallelSearchInput = {
  readonly question: string;
  readonly query: string;
};

type ParallelSearchShape = {
  readonly hasApiKey: boolean;
  readonly search: (
    input: ParallelSearchInput,
  ) => Effect.Effect<readonly ParallelSearchResult[], ParallelSearchError>;
};

export class ParallelSearchService extends Context.Service<
  ParallelSearchService,
  ParallelSearchShape
>()("@great-minds/server/ParallelSearchService") {}

export class ParallelSearchError extends Data.TaggedError("ParallelSearchError")<{
  readonly message: string;
  readonly cause?: unknown;
  readonly issue?: Schema.SchemaError["issue"];
}> {}

const ParallelSearchResponse = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      url: Schema.String,
      title: Schema.optionalKey(Schema.String),
      excerpts: Schema.Array(Schema.String),
    }),
  ),
});
const decodeParallelSearchResponse = Schema.decodeUnknownResult(ParallelSearchResponse);

export const ParallelSearchLive = Layer.effect(
  ParallelSearchService,
  Effect.map(AppConfig, (config) => {
    const apiKey = optionalRedactedValue(config.parallelApiKey);
    return {
      hasApiKey: apiKey !== undefined,
      search: ({ question, query }) =>
        Effect.tryPromise({
          try: async (signal) => {
            if (apiKey === undefined) {
              throw new ParallelSearchError({ message: "Parallel API key is not configured" });
            }
            const objective =
              "Find concrete facts — events, dates, figures, named people and " +
              "organizations, and what people concretely said or did — relevant " +
              `to this question: ${question}`;
            const response = await fetch(config.parallelSearchUrl, {
              method: "POST",
              headers: {
                "x-api-key": apiKey,
                "parallel-beta": "search-extract-2025-10-10",
                "content-type": "application/json",
              },
              body: JSON.stringify({
                objective,
                search_queries: [query],
                max_results: 5,
                max_chars_per_result: 1500,
              }),
              signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
            });
            if (!response.ok) {
              throw new ParallelSearchError({
                message: `Parallel search returned ${response.status}`,
              });
            }
            const body = decodeParallelSearchResponse(await response.json());
            if (body._tag === "Failure")
              throw new ParallelSearchError({
                message: "Parallel search returned an invalid response",
                issue: body.failure.issue,
              });
            return body.success.results.map((result) => ({
              title:
                result.title !== undefined && result.title.length > 0 ? result.title : result.url,
              url: result.url,
              excerpts: result.excerpts,
            }));
          },
          catch: (cause) =>
            cause instanceof ParallelSearchError
              ? cause
              : new ParallelSearchError({ message: "Parallel search failed", cause }),
        }),
    } satisfies ParallelSearchShape;
  }),
);
