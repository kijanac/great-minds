import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { OpenAIChatCompletionRequestSchema } from "@great-minds/protocol-openai/chat";
import { createAuthenticateBearer, requireApiKeyScope } from "../auth.js";
import type { BackendRuntime } from "@great-minds/db/context";
import type { ApiConfig, AppEnv } from "../context.js";
import { chatCompletionResponse, modelListResponse } from "../openai-provider.js";

export function createOpenAiRoutes(runtime: BackendRuntime, config: ApiConfig) {
  const authenticateBearer = createAuthenticateBearer(runtime, config.auth);

  return new Hono<AppEnv>()
  .get("/models", authenticateBearer, requireApiKeyScope("query"), (c) =>
    modelListResponse(config.openAiProvider, c.get("requestId")),
  )
  .post(
    "/chat/completions",
    authenticateBearer,
    requireApiKeyScope("query"),
    zValidator("json", OpenAIChatCompletionRequestSchema),
    (c) =>
      chatCompletionResponse(
        config.openAiProvider,
        c.req.valid("json"),
        c.get("requestId"),
      ),
  );
}
