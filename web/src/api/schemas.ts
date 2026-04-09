import { z } from "zod";

export const sourceRefSchema = z.object({
  label: z.string(),
  type: z.enum(["article", "raw", "search"]),
  thinking: z.string().optional(),
});

export const thinkingBlockSchema = z.object({
  sources: z.array(sourceRefSchema),
});

export const btwMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  text: z.string(),
});

export const brainOverviewSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string(),
});

export const brainDetailSchema = brainOverviewSchema.extend({
  owner_id: z.string(),
  created_at: z.string(),
  member_count: z.number(),
  article_count: z.number(),
});

export const membershipSchema = z.object({
  user_id: z.string(),
  email: z.string(),
  role: z.string(),
});

export type SourceRef = z.infer<typeof sourceRefSchema>;
export type ThinkingBlock = z.infer<typeof thinkingBlockSchema>;
export type BtwMessage = z.infer<typeof btwMessageSchema>;
export type BrainOverview = z.infer<typeof brainOverviewSchema>;
export type BrainDetail = z.infer<typeof brainDetailSchema>;
export type Membership = z.infer<typeof membershipSchema>;
