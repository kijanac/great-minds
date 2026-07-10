import { Context, Effect, Layer, Option, Redacted } from "effect";

import { AppConfig } from "./config.ts";

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
  readonly search: (input: ParallelSearchInput) => Promise<readonly ParallelSearchResult[]>;
};

export class ParallelSearchService extends Context.Service<
  ParallelSearchService,
  ParallelSearchShape
>()("@great-minds/server/ParallelSearchService") {}

export class ParallelSearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParallelSearchError";
  }
}

const optionalRedactedValue = (value: Option.Option<Redacted.Redacted<string>>) =>
  Option.match(value, {
    onNone: () => undefined,
    onSome: Redacted.value,
  });

const asResult = (value: unknown): ParallelSearchResult | undefined => {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const url = typeof record.url === "string" ? record.url : undefined;
  const title = typeof record.title === "string" && record.title.length > 0 ? record.title : url;
  const rawExcerpts = record.excerpts;
  const excerpts = Array.isArray(rawExcerpts)
    ? rawExcerpts.filter((excerpt): excerpt is string => typeof excerpt === "string")
    : typeof rawExcerpts === "string"
      ? [rawExcerpts]
      : [];
  if (url === undefined) {
    return undefined;
  }
  return { title: title ?? url, url, excerpts };
};

export const ParallelSearchLive = Layer.effect(
  ParallelSearchService,
  Effect.map(AppConfig, (config) => {
    const apiKey = optionalRedactedValue(config.parallelApiKey);
    return {
      hasApiKey: apiKey !== undefined,
      search: async ({ question, query }) => {
        if (apiKey === undefined) {
          throw new ParallelSearchError("Parallel API key is not configured");
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
          signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok) {
          throw new ParallelSearchError(`Parallel search returned ${response.status}`);
        }
        const json = (await response.json()) as Record<string, unknown>;
        const results = json.results;
        if (!Array.isArray(results)) {
          return [];
        }
        return results.flatMap((result) => {
          const parsed = asResult(result);
          return parsed === undefined ? [] : [parsed];
        });
      },
    } satisfies ParallelSearchShape;
  }),
);
