import { z } from "zod";

export const QueryHistoryMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1),
});

export const QueryRequestSchema = z.object({
  question: z.string().trim().min(1),
  model: z.string().trim().min(1),
  history: z.array(QueryHistoryMessageSchema).default([]),
});

export const QueryAnswerSchema = z.object({
  answer: z.string(),
});

export type QueryHistoryMessage = z.infer<typeof QueryHistoryMessageSchema>;
export type QueryRequest = z.output<typeof QueryRequestSchema>;
export type QueryAnswer = z.infer<typeof QueryAnswerSchema>;
