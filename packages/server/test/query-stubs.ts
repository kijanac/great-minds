import { Effect, Layer } from "effect";

import { EmbeddingsService } from "../src/embeddings.ts";
import { CostLookupService } from "../src/llm-costs.ts";
import {
  LanguageModel,
  type CompleteInput,
  type LlmUsage,
  type ModelCompletion,
  type ModelStreamPart,
  RetryableModelError,
  type StreamChatInput,
} from "../src/llm.ts";
import { ParallelSearchService, type ParallelSearchResult } from "../src/parallel.ts";

type StreamScript =
  | {
      readonly kind: "parts";
      readonly parts: readonly ModelStreamPart[];
      readonly errorAfterParts?: unknown;
    }
  | {
      readonly kind: "throw";
      readonly error: unknown;
    };

type CompleteScript = ModelCompletion | ((input: CompleteInput) => ModelCompletion);

export const retryableModelError = (message = "rate limited") => new RetryableModelError(message);

export const toolCallPart = (
  index: number,
  id: string,
  name: string,
  args: Record<string, unknown>,
): ModelStreamPart => ({
  type: "tool_call_delta",
  delta: {
    index,
    id,
    name,
    argumentsDelta: JSON.stringify(args),
  },
});

export const finishPart = (
  finishReason: string | null,
  generationId?: string,
  usage?: LlmUsage,
): ModelStreamPart => ({
  type: "finish",
  finishReason,
  generationId,
  usage,
});

export const tokenPart = (text: string): ModelStreamPart => ({ type: "token", text });

export const malformedToolCallPart = (
  index: number,
  id: string,
  name: string,
  argumentsDelta: string,
): ModelStreamPart => ({
  type: "tool_call_delta",
  delta: { index, id, name, argumentsDelta },
});

export const makeScriptedLanguageModel = (options: {
  readonly streams?: readonly StreamScript[];
  readonly completions?: readonly CompleteScript[];
  readonly hasApiKey?: boolean;
}) => {
  const streamScripts = [...(options.streams ?? [])];
  const completionScripts = [...(options.completions ?? [])];
  const streamCalls: StreamChatInput[] = [];
  const completeCalls: CompleteInput[] = [];
  const service = {
    hasApiKey: options.hasApiKey ?? true,
    streamChat: (input: StreamChatInput) => {
      streamCalls.push(input);
      const script = streamScripts.shift();
      async function* run() {
        if (script === undefined) {
          throw new Error("No scripted stream response");
        }
        if (script.kind === "throw") {
          throw script.error;
        }
        for (const part of script.parts) {
          yield part;
        }
        if (script.errorAfterParts !== undefined) {
          throw script.errorAfterParts;
        }
      }
      return run();
    },
    complete: async (input: CompleteInput) => {
      completeCalls.push(input);
      const script = completionScripts.shift();
      if (script === undefined) {
        throw new Error("No scripted completion response");
      }
      return typeof script === "function" ? script(input) : script;
    },
  };
  return {
    streamCalls,
    completeCalls,
    layer: Layer.succeed(LanguageModel, service),
  };
};

export const makeCostLookup = (costs: ReadonlyMap<string, number>) => {
  const lookups: string[] = [];
  return {
    lookups,
    layer: Layer.succeed(CostLookupService, {
      lookupGenerationCost: (generationId: string) => {
        lookups.push(generationId);
        return Effect.succeed(costs.get(generationId) ?? null);
      },
    }),
  };
};

export const makeEmbeddings = (vectors: ReadonlyMap<string, readonly number[]>) => {
  const calls: string[][] = [];
  return {
    calls,
    layer: Layer.succeed(EmbeddingsService, {
      embed: async (texts: readonly string[]) => {
        calls.push([...texts]);
        return texts.map((text) => {
          const vector = vectors.get(text);
          if (vector === undefined) {
            throw new Error(`No embedding stub for ${text}`);
          }
          return vector;
        });
      },
    }),
  };
};

export const makeParallelSearch = (results: readonly ParallelSearchResult[] = []) => {
  const calls: { question: string; query: string }[] = [];
  return {
    calls,
    layer: Layer.succeed(ParallelSearchService, {
      hasApiKey: true,
      search: async (input: { question: string; query: string }) => {
        calls.push(input);
        return results;
      },
    }),
  };
};

export const makeDisabledParallelSearch = () =>
  Layer.succeed(ParallelSearchService, {
    hasApiKey: false,
    search: async () => {
      throw new Error("Parallel should not be called");
    },
  });
