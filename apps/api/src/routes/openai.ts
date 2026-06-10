import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { OpenAIChatCompletionRequestSchema } from "@great-minds/protocol-openai/chat";
import { authenticateBearer, requireApiKeyScope } from "../auth.js";
import type { AppEnv } from "../context.js";
import { chatCompletionResponse, modelListResponse } from "../openai-provider.js";

export const openAiRoutes = new Hono<AppEnv>()
  .get("/models", authenticateBearer, requireApiKeyScope("query"), (c) =>
    modelListResponse(c.get("openAiProvider"), c.get("requestId")),
  )
  .post(
    "/chat/completions",
    authenticateBearer,
    requireApiKeyScope("query"),
    zValidator("json", OpenAIChatCompletionRequestSchema),
    (c) =>
      chatCompletionResponse(
        c.get("openAiProvider"),
        c.req.valid("json"),
        c.get("requestId"),
      ),
  );
