import { Context, Data, Duration, Effect, Layer, Schedule, Schema, Stream } from "effect";
import * as Sse from "effect/unstable/encoding/Sse";

import { AppConfig, optionalRedactedValue } from "./config.ts";
import { scopedAbortSignal } from "./scoped-abort-signal.ts";

export const LlmToolDefinitionSchema = Schema.Struct({
  type: Schema.Literal("function"),
  function: Schema.Struct({
    name: Schema.String,
    description: Schema.String,
    parameters: Schema.Record(Schema.String, Schema.Unknown),
  }),
});
export type LlmToolDefinition = typeof LlmToolDefinitionSchema.Type;

export const LlmTextContentPartSchema = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
  cache_control: Schema.optionalKey(Schema.Struct({ type: Schema.Literal("ephemeral") })),
});
export type LlmTextContentPart = typeof LlmTextContentPartSchema.Type;

export const LlmAssistantToolCallSchema = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("function"),
  function: Schema.Struct({ name: Schema.String, arguments: Schema.String }),
});
export type LlmAssistantToolCall = typeof LlmAssistantToolCallSchema.Type;

export const LlmMessageSchema = Schema.Union([
  Schema.Struct({
    role: Schema.Literals(["system", "user", "assistant"] as const),
    content: Schema.Union([Schema.String, Schema.Null, Schema.Array(LlmTextContentPartSchema)]),
    tool_calls: Schema.optionalKey(Schema.Array(LlmAssistantToolCallSchema)),
  }),
  Schema.Struct({
    role: Schema.Literal("tool"),
    tool_call_id: Schema.String,
    content: Schema.String,
  }),
]);
export type LlmMessage = typeof LlmMessageSchema.Type;
export type LlmToolMessage = Extract<LlmMessage, { role: "tool" }>;
export type LlmTextMessage = Exclude<LlmMessage, LlmToolMessage>;

export type LlmToolCallDelta = {
  readonly index: number;
  readonly id?: string;
  readonly name?: string;
  readonly argumentsDelta?: string;
};

export type LlmUsage = {
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
  readonly cost?: number;
};

export type ModelStreamPart =
  | {
      readonly type: "token";
      readonly text: string;
    }
  | {
      readonly type: "tool_call_delta";
      readonly delta: LlmToolCallDelta;
    }
  | {
      readonly type: "finish";
      readonly finishReason: string | null;
      readonly generationId?: string;
      readonly usage?: LlmUsage;
    };

export type StreamChatInput = {
  readonly model: string;
  readonly messages: readonly LlmMessage[];
  readonly tools: readonly LlmToolDefinition[];
  readonly temperature: number;
};

export type CompleteInput = {
  readonly model: string;
  readonly messages: readonly LlmMessage[];
  readonly temperature?: number;
  readonly responseFormat?: "json_object" | Record<string, unknown>;
  readonly requestProfile?: "default" | "compile";
};

export type ModelCompletion = {
  readonly text: string;
  readonly finishReason?: string | null;
  readonly generationId?: string;
  readonly usage?: LlmUsage;
};

type LanguageModelShape = {
  readonly hasApiKey: boolean;
  readonly streamChat: (
    input: StreamChatInput,
  ) => Stream.Stream<ModelStreamPart, RetryableModelError | ModelProviderError>;
  readonly complete: (
    input: CompleteInput,
  ) => Effect.Effect<ModelCompletion, RetryableModelError | ModelProviderError>;
};

export class LanguageModel extends Context.Service<LanguageModel, LanguageModelShape>()(
  "@great-minds/server/LanguageModel",
) {}

export class RetryableModelError extends Data.TaggedError("RetryableModelError")<{
  readonly message: string;
  readonly retryAfterMs?: number;
}> {}

export class ModelProviderError extends Data.TaggedError("ModelProviderError")<{
  readonly message: string;
  readonly cause?: unknown;
  readonly issue?: Schema.SchemaError["issue"];
  readonly transient?: boolean;
}> {}

export const stripJsonFence = (raw: string) =>
  raw.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");

const streamChunkTimeoutMs = 30_000;
const rateLimitRetries = 6;
const maxRateLimitBackoffMs = 60_000;
const transientRetries = 2;

const rateLimitRetry = {
  times: rateLimitRetries,
  while: (error: RetryableModelError | ModelProviderError) => error._tag === "RetryableModelError",
  schedule: Schedule.exponential("2 seconds").pipe(
    Schedule.modifyDelay(
      ({
        input,
        duration,
      }: Schedule.Metadata<Duration.Duration, RetryableModelError | ModelProviderError>) =>
        Effect.succeed(
          input._tag === "RetryableModelError" && input.retryAfterMs !== undefined
            ? input.retryAfterMs
            : Math.min(maxRateLimitBackoffMs, Duration.toMillis(duration)),
        ),
    ),
  ),
};

const transientRetry = {
  times: transientRetries,
  while: (error: RetryableModelError | ModelProviderError) =>
    error._tag === "ModelProviderError" && error.transient === true,
  schedule: Schedule.exponential("2 seconds"),
};

const openRouterHeaders = (apiKey: string) => ({
  authorization: `Bearer ${apiKey}`,
  "content-type": "application/json",
});

const WireUsage = Schema.Struct({
  prompt_tokens: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  completion_tokens: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  total_tokens: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  cost: Schema.optionalKey(Schema.NullOr(Schema.Number)),
});

const WireToolCallDelta = Schema.Struct({
  index: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  function: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        name: Schema.optionalKey(Schema.NullOr(Schema.String)),
        arguments: Schema.optionalKey(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
});

const WireStreamChunk = Schema.Struct({
  error: Schema.optionalKey(Schema.Unknown),
  id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  usage: Schema.optionalKey(Schema.NullOr(WireUsage)),
  choices: Schema.optionalKey(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          delta: Schema.optionalKey(
            Schema.NullOr(
              Schema.Struct({
                content: Schema.optionalKey(Schema.NullOr(Schema.String)),
                tool_calls: Schema.optionalKey(Schema.NullOr(Schema.Array(WireToolCallDelta))),
              }),
            ),
          ),
          finish_reason: Schema.optionalKey(Schema.NullOr(Schema.String)),
        }),
      ),
    ),
  ),
});
const decodeWireStreamChunk = Schema.decodeEffect(Schema.fromJsonString(WireStreamChunk));

const WireCompletion = Schema.Struct({
  id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  usage: Schema.optionalKey(Schema.NullOr(WireUsage)),
  choices: Schema.optionalKey(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          message: Schema.optionalKey(
            Schema.NullOr(
              Schema.Struct({ content: Schema.optionalKey(Schema.NullOr(Schema.String)) }),
            ),
          ),
          finish_reason: Schema.optionalKey(Schema.NullOr(Schema.String)),
        }),
      ),
    ),
  ),
});
const decodeWireCompletion = Schema.decodeUnknownEffect(WireCompletion);

const usageFrom = (usage: typeof WireUsage.Type | null | undefined): LlmUsage | undefined => {
  if (usage === undefined || usage === null) {
    return undefined;
  }
  const promptTokens = usage.prompt_tokens ?? undefined;
  const completionTokens = usage.completion_tokens ?? undefined;
  const totalTokens = usage.total_tokens ?? undefined;
  const cost = usage.cost ?? undefined;
  if (
    promptTokens === undefined &&
    completionTokens === undefined &&
    totalTokens === undefined &&
    cost === undefined
  ) {
    return undefined;
  }
  return { promptTokens, completionTokens, totalTokens, cost };
};

const retryAfterMs = (headers: Headers) => {
  const seconds = Number.parseFloat(headers.get("retry-after") ?? "");
  return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : undefined;
};

const responseDetail = (response: Response) =>
  Effect.tryPromise(() => response.text()).pipe(
    Effect.map((text) => text.slice(0, 500)),
    Effect.orElseSucceed(() => ""),
  );

const streamRequestBody = (input: StreamChatInput) => ({
  model: input.model,
  messages: input.messages,
  tools: input.tools,
  temperature: input.temperature,
  stream: true,
  stream_options: { include_usage: true },
  usage: { include: true },
  provider: {
    allow_fallbacks: true,
    sort: "throughput",
  },
});

export const completionRequestBody = (input: CompleteInput) => {
  const responseFormat =
    typeof input.responseFormat === "string"
      ? { type: input.responseFormat }
      : input.responseFormat;
  const common = {
    model: input.model,
    messages: input.messages,
    ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
    response_format: responseFormat,
  };
  if (input.requestProfile === "compile") {
    return {
      ...common,
      usage: { include: true },
      provider: { require_parameters: true },
    };
  }
  return {
    ...common,
    stream: false,
    usage: { include: true },
    provider: {
      allow_fallbacks: true,
      sort: "throughput",
    },
  };
};

const toolCallDeltas = (
  toolCalls: readonly (typeof WireToolCallDelta.Type)[] | null | undefined,
): readonly LlmToolCallDelta[] =>
  (toolCalls ?? []).map((item) => ({
    index: item.index ?? 0,
    id: item.id ?? undefined,
    name: item.function?.name ?? undefined,
    argumentsDelta: item.function?.arguments ?? undefined,
  }));

const makeSseDataParser = () => {
  const pending: string[] = [];
  const parser = Sse.makeParser((event) => {
    if (event._tag === "Event") pending.push(event.data);
  });
  return (chunk: string) => {
    const error = parser.feed(chunk);
    return error === undefined
      ? Effect.succeed(pending.splice(0))
      : Effect.fail(
          new ModelProviderError({ message: "model stream frame too large", cause: error }),
        );
  };
};

const sseData = <E>(text: Stream.Stream<string, E>) =>
  Stream.mapAccumEffect(text, makeSseDataParser, (feed, chunk) =>
    Effect.map(feed(chunk), (frames) => [feed, frames] as const),
  );

type StreamTrailer = {
  readonly finishReason: string | null;
  readonly generationId: string | undefined;
  readonly usage: LlmUsage | undefined;
};

const emptyTrailer: StreamTrailer = {
  finishReason: null,
  generationId: undefined,
  usage: undefined,
};

const foldStreamFrame = (
  trailer: StreamTrailer,
  data: string,
): Effect.Effect<readonly [StreamTrailer, readonly ModelStreamPart[]], ModelProviderError> =>
  Effect.gen(function* () {
    if (data.length === 0 || data === "[DONE]") {
      return [trailer, []] as const;
    }
    const chunk = yield* decodeWireStreamChunk(data).pipe(
      Effect.mapError(
        (error) =>
          new ModelProviderError({
            message: "model provider sent a malformed stream frame",
            issue: error.issue,
          }),
      ),
    );
    const choice = chunk.choices?.[0];
    if (chunk.error != null || choice?.finish_reason === "error") {
      return yield* new ModelProviderError({ message: "model provider failed while streaming" });
    }
    const next: StreamTrailer = {
      finishReason: choice?.finish_reason ?? trailer.finishReason,
      generationId: chunk.id ?? trailer.generationId,
      usage: usageFrom(chunk.usage) ?? trailer.usage,
    };
    const parts: ModelStreamPart[] = [];
    const content = choice?.delta?.content;
    if (content !== undefined && content !== null && content.length > 0) {
      parts.push({ type: "token", text: content });
    }
    for (const delta of toolCallDeltas(choice?.delta?.tool_calls)) {
      parts.push({ type: "tool_call_delta", delta });
    }
    return [next, parts] as const;
  });

const finishPart = (trailer: StreamTrailer): readonly ModelStreamPart[] => [
  {
    type: "finish",
    finishReason: trailer.finishReason,
    generationId: trailer.generationId,
    usage: trailer.usage,
  },
];

const requireFinishReason = (part: ModelStreamPart) =>
  part.type === "finish" && (part.finishReason === null || part.finishReason.length === 0)
    ? Effect.fail(new ModelProviderError({ message: "model stream ended without a finish reason" }))
    : Effect.succeed(part);

export const parseOpenRouterStream = (
  response: Response,
): Stream.Stream<ModelStreamPart, ModelProviderError> => {
  const body = response.body;
  if (body === null) {
    return Stream.fail(
      new ModelProviderError({ message: "model provider returned no stream body" }),
    );
  }
  return Stream.fromReadableStream({
    evaluate: () => body,
    onError: (cause) => new ModelProviderError({ message: "model stream failed", cause }),
  }).pipe(
    Stream.timeoutOrElse({
      duration: streamChunkTimeoutMs,
      orElse: () => Stream.fail(new ModelProviderError({ message: "model stream stalled" })),
    }),
    Stream.decodeText(),
    sseData,
    Stream.mapAccumEffect(() => emptyTrailer, foldStreamFrame, { onHalt: finishPart }),
    Stream.mapEffect(requireFinishReason),
  );
};

const makeLanguageModel = Effect.gen(function* () {
  const config = yield* AppConfig;
  const apiKey = optionalRedactedValue(config.openRouterApiKey);
  const chatUrl = `${config.openRouterApiUrl.replace(/\/$/, "")}/chat/completions`;

  const openChat = (body: unknown) =>
    Effect.gen(function* () {
      if (apiKey === undefined) {
        return yield* new ModelProviderError({ message: "OpenRouter API key is not configured" });
      }
      const signal = yield* scopedAbortSignal;
      const response = yield* Effect.tryPromise({
        try: () =>
          fetch(chatUrl, {
            method: "POST",
            headers: openRouterHeaders(apiKey),
            body: JSON.stringify(body),
            signal,
          }),
        catch: (cause) =>
          new ModelProviderError({ message: "model provider request failed", cause, transient: true }),
      });
      if (response.status === 429) {
        return yield* new RetryableModelError({
          message: "model provider rate limited request",
          retryAfterMs: retryAfterMs(response.headers),
        });
      }
      if (!response.ok) {
        const detail = yield* responseDetail(response);
        return yield* new ModelProviderError({
          message: `model provider returned ${response.status}: ${detail}`,
          transient: response.status >= 500,
        });
      }
      return response;
    });

  const streamChat = (input: StreamChatInput) =>
    Stream.unwrap(Effect.map(openChat(streamRequestBody(input)), parseOpenRouterStream));

  const complete = (input: CompleteInput) =>
    Effect.gen(function* () {
      const response = yield* openChat(completionRequestBody(input));
      const payload = yield* Effect.tryPromise({
        try: () => response.json(),
        catch: (cause) =>
          new ModelProviderError({
            message: "model provider returned an unreadable completion",
            cause,
            transient: true,
          }),
      });
      const completion = yield* decodeWireCompletion(payload).pipe(
        Effect.mapError(
          (error) =>
            new ModelProviderError({
              message: "model provider returned a malformed completion",
              issue: error.issue,
            }),
        ),
      );
      const first = completion.choices?.[0];
      return {
        text: first?.message?.content ?? "",
        finishReason: first?.finish_reason ?? null,
        generationId: completion.id ?? undefined,
        usage: usageFrom(completion.usage),
      } satisfies ModelCompletion;
    }).pipe(Effect.scoped, Effect.retry(rateLimitRetry), Effect.retry(transientRetry));

  return { hasApiKey: apiKey !== undefined, streamChat, complete } satisfies LanguageModelShape;
});

export const LanguageModelLive = Layer.effect(LanguageModel, makeLanguageModel);
