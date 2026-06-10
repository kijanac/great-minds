import { z } from "zod";

export const LlmMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1),
});

export type LlmMessage = z.infer<typeof LlmMessageSchema>;
