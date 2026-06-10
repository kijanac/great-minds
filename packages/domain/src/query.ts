import { z } from "zod";
import { LlmMessageSchema } from "./llm.js";

export const QueryRequestSchema = z.object({
  question: z.string().trim().min(1),
  model: z.string().trim().min(1),
  history: z.array(LlmMessageSchema).default([]),
});

export const QueryAnswerSchema = z.object({
  answer: z.string(),
});

export type QueryRequest = z.output<typeof QueryRequestSchema>;
export type QueryAnswer = z.infer<typeof QueryAnswerSchema>;
