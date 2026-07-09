import { AuthenticatedUser, RequestCodeInput, TokenPair, VerifyCodeInput } from "@great-minds/domain";
import { Schema } from "effect";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";

export const SseEvent = Schema.Struct({
  type: Schema.Literals(["delta", "tool-call", "tool-result", "finish", "error"] as const),
  text: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  promptTokens: Schema.optionalKey(Schema.Number),
  completionTokens: Schema.optionalKey(Schema.Number),
  totalTokens: Schema.optionalKey(Schema.Number),
  costUsd: Schema.optionalKey(Schema.Union([Schema.Number, Schema.Null]))
});
export type SseEvent = typeof SseEvent.Type;

export const GreatMindsSpikeApi = HttpApi.make("great-minds-spike").add(
  HttpApiGroup.make("auth").add(
    HttpApiEndpoint.post("requestCode", "/auth/request-code", {
      payload: RequestCodeInput,
      success: HttpApiSchema.NoContent
    }),
    HttpApiEndpoint.post("verifyCode", "/auth/verify-code", {
      payload: VerifyCodeInput,
      success: TokenPair
    }),
    HttpApiEndpoint.get("me", "/auth/me", {
      success: AuthenticatedUser
    })
  ),
  HttpApiGroup.make("query").add(
    HttpApiEndpoint.get("stream", "/query/stream", {
      success: HttpApiSchema.StreamSse({ data: SseEvent })
    })
  )
);
