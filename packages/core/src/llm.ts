import { Context, Data, Effect } from "effect";
import type { LlmMessage } from "@great-minds/domain/llm";

export type LlmCompletionRequest = {
  model: string;
  messages: LlmMessage[];
};

export type LlmCompletion = {
  content: string;
};

export class LlmRateLimited extends Data.TaggedError("LlmRateLimited")<{
  message: string;
  retryAfterMs: number | undefined;
}> {}

export class LlmUnavailable extends Data.TaggedError("LlmUnavailable")<{
  message: string;
}> {}

export class LlmRejected extends Data.TaggedError("LlmRejected")<{
  message: string;
}> {}

export class LlmBadResponse extends Data.TaggedError("LlmBadResponse")<{
  message: string;
}> {}

export type LlmProviderError = LlmRateLimited | LlmUnavailable | LlmRejected | LlmBadResponse;

export class LlmClient extends Context.Tag("LlmClient")<
  LlmClient,
  {
    readonly complete: (request: LlmCompletionRequest) => Effect.Effect<LlmCompletion, LlmProviderError>;
  }
>() {}
