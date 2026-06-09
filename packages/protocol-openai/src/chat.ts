import { z } from "zod";

export const OpenAIChatRoleSchema = z.enum(["system", "developer", "user", "assistant", "tool"]);

export const OpenAIContentPartSchema = z.object({ type: z.string() }).passthrough();

export const OpenAIChatMessageSchema = z
  .object({
    role: OpenAIChatRoleSchema,
    content: z.union([z.string(), z.array(OpenAIContentPartSchema), z.null()]).optional(),
    name: z.string().optional(),
    tool_call_id: z.string().optional(),
    tool_calls: z.array(z.unknown()).optional(),
  })
  .passthrough();

export const OpenAIChatCompletionRequestSchema = z
  .object({
    model: z.string(),
    messages: z.array(OpenAIChatMessageSchema).min(1),
    stream: z.boolean().optional(),
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    max_tokens: z.number().int().positive().optional(),
    max_completion_tokens: z.number().int().positive().optional(),
    tools: z.array(z.unknown()).optional(),
    tool_choice: z.unknown().optional(),
    response_format: z.unknown().optional(),
    user: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export const OpenAIErrorResponseSchema = z.object({
  error: z.object({
    message: z.string(),
    type: z.string(),
    param: z.string().nullable().optional(),
    code: z.string().nullable().optional(),
  }),
});

export type OpenAIChatRole = z.infer<typeof OpenAIChatRoleSchema>;
export type OpenAIChatMessage = z.infer<typeof OpenAIChatMessageSchema>;
export type OpenAIChatCompletionRequest = z.input<typeof OpenAIChatCompletionRequestSchema>;
export type OpenAIErrorResponse = z.infer<typeof OpenAIErrorResponseSchema>;
