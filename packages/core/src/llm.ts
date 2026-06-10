import { Context, Data, Effect } from "effect";

export type LlmMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type LlmCompletionRequest = {
  model: string;
  messages: LlmMessage[];
};

export type LlmCompletion = {
  content: string;
};

export class LlmProviderError extends Data.TaggedError("LlmProviderError")<{
  message: string;
}> {}

export class LlmClient extends Context.Tag("LlmClient")<
  LlmClient,
  {
    readonly complete: (request: LlmCompletionRequest) => Effect.Effect<LlmCompletion, LlmProviderError>;
  }
>() {}
