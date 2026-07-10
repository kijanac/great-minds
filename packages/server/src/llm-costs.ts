import { Context, Effect, Layer, Option, Redacted } from "effect";

import { AppConfig } from "./config.ts";

type CostLookupShape = {
  readonly lookupGenerationCost: (generationId: string) => Promise<number | null>;
};

export class CostLookupService extends Context.Service<CostLookupService, CostLookupShape>()(
  "@great-minds/server/CostLookupService",
) {}

const optionalRedactedValue = (value: Option.Option<Redacted.Redacted<string>>) =>
  Option.match(value, {
    onNone: () => undefined,
    onSome: Redacted.value,
  });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const numberFromUnknown = (value: unknown) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.length > 0) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};

const findCost = (value: unknown): number | null => {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  for (const key of ["total_cost", "cost", "cost_usd", "total_cost_usd"]) {
    const cost = numberFromUnknown(record[key]);
    if (cost !== undefined) {
      return cost;
    }
  }
  if ("data" in record) {
    return findCost(record.data);
  }
  return null;
};

export const CostLookupLive = Layer.effect(
  CostLookupService,
  Effect.map(AppConfig, (config) => {
    const apiKey = optionalRedactedValue(config.openRouterApiKey);
    return {
      lookupGenerationCost: async (generationId) => {
        if (apiKey === undefined || generationId.length === 0) {
          return null;
        }
        const url = `${config.openRouterApiUrl.replace(/\/$/, "")}/generation?id=${encodeURIComponent(
          generationId,
        )}`;
        for (let attempt = 0; attempt < 5; attempt += 1) {
          const response = await fetch(url, {
            method: "GET",
            headers: {
              authorization: `Bearer ${apiKey}`,
            },
          });
          if (response.ok) {
            return findCost(await response.json());
          }
          if (![404, 408, 409, 425, 429, 500, 502, 503, 504].includes(response.status)) {
            return null;
          }
          await sleep(100 * 2 ** attempt);
        }
        return null;
      },
    } satisfies CostLookupShape;
  }),
);
