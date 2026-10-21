import { Effect, Layer, Stream } from "effect";

import { EmbeddingsService } from "../src/embeddings.ts";
import { CostLookupService } from "../src/llm-costs.ts";
import {
  LanguageModel,
  type CompleteInput,
  type LlmUsage,
  type ModelCompletion,
  type ModelProviderError,
  type ModelStreamPart,
  RetryableModelError,
  type StreamChatInput,
} from "../src/llm.ts";
import { ParallelSearchService, type ParallelSearchResult } from "../src/parallel.ts";

type ModelRequestError = RetryableModelError | ModelProviderError;

type StreamScript =
  | {
      readonly kind: "stream";
      readonly stream: Stream.Stream<ModelStreamPart, ModelRequestError>;
    }
  | {
      readonly kind: "parts";
      readonly parts: readonly ModelStreamPart[];
      readonly errorAfterParts?: ModelRequestError;
    }
  | {
      readonly kind: "fail";
      readonly error: ModelRequestError;
    };

type CompleteScript = ModelCompletion | Effect.Effect<ModelCompletion, ModelRequestError>;

export const retryableModelError = (message = "rate limited") =>
  new RetryableModelError({ message });

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
      if (script === undefined) return Stream.die(new Error("No scripted stream response"));
      if (script.kind === "stream") return script.stream;
      if (script.kind === "fail") return Stream.fail(script.error);
      const parts = Stream.fromIterable(script.parts);
      return script.errorAfterParts === undefined
        ? parts
        : Stream.concat(parts, Stream.fail(script.errorAfterParts));
    },
    complete: (input: CompleteInput) => Effect.suspend(() => {
      completeCalls.push(input);
      const script = completionScripts.shift();
      if (script === undefined) {
        return Effect.die(new Error("No scripted completion response"));
      }
      return Effect.isEffect(script) ? script : Effect.succeed(script);
    }),
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
      embed: (texts: readonly string[]) => Effect.sync(() => {
        calls.push([...texts]);
        return texts.map((text) => {
          const vector = vectors.get(text);
          if (vector === undefined) {
            throw new Error(`No embedding stub for ${text}`);
          }
          return vector;
        });
      }),
    }),
  };
};

export const makeParallelSearch = (results: readonly ParallelSearchResult[] = []) => {
  const calls: { question: string; query: string }[] = [];
  return {
    calls,
    layer: Layer.succeed(ParallelSearchService, {
      hasApiKey: true,
      search: (input: { question: string; query: string }) => Effect.sync(() => {
        calls.push(input);
        return results;
      }),
    }),
  };
};

export const makeDisabledParallelSearch = () =>
  Layer.succeed(ParallelSearchService, {
    hasApiKey: false,
    search: () => Effect.die(new Error("Parallel should not be called")),
  });
