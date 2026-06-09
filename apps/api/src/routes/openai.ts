import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import {
  OpenAIChatCompletionRequestSchema,
  OpenAIErrorResponseSchema,
} from "@great-minds/protocol-openai/chat";
import { OpenAIModelListSchema } from "@great-minds/protocol-openai/models";
import { authenticateBearer, requireApiKeyScope } from "../auth.js";
import type { AppEnv } from "../context.js";

export const openAiRoutes = new Hono<AppEnv>()
  .get("/models", authenticateBearer, requireApiKeyScope("query"), (c) => {
    const models = OpenAIModelListSchema.parse({
      object: "list",
      data: [],
    });

    return c.json(models);
  })
  .post(
    "/chat/completions",
    authenticateBearer,
    requireApiKeyScope("query"),
    zValidator("json", OpenAIChatCompletionRequestSchema),
    (c) => {
      c.req.valid("json");

      const error = OpenAIErrorResponseSchema.parse({
        error: {
          message: "Chat completions are not implemented yet",
          type: "not_implemented_error",
          code: "not_implemented",
        },
      });

      return c.json(error, 501);
    },
  );
