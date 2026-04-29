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

export const pageInfoSchema = z.object({
  limit: z.number(),
  offset: z.number(),
  total: z.number(),
});

export function paginatedSchema<T extends z.ZodTypeAny>(itemSchema: T) {
  return z.object({
    items: z.array(itemSchema),
    pagination: pageInfoSchema,
  });
}

export const facetCountSchema = z.object({
  value: z.string(),
  count: z.number(),
});

export function facetedPaginatedSchema<
  T extends z.ZodTypeAny,
  F extends z.ZodTypeAny,
>(itemSchema: T, facetsSchema: F) {
  return paginatedSchema(itemSchema).extend({
    facets: facetsSchema,
  });
}

export const brainOverviewListSchema = paginatedSchema(brainOverviewSchema);

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

export const membershipListSchema = paginatedSchema(membershipSchema);

export const brainConfigSchema = z.object({
  thematic_hint: z.string(),
  kinds: z.array(z.string()),
});

export const draftHintResponseSchema = z.object({
  thematic_hint: z.string(),
});

export type SourceRef = z.infer<typeof sourceRefSchema>;
export type ThinkingBlock = z.infer<typeof thinkingBlockSchema>;
export type BtwMessage = z.infer<typeof btwMessageSchema>;
export type BrainOverview = z.infer<typeof brainOverviewSchema>;
export type PageInfo = z.infer<typeof pageInfoSchema>;
export type FacetCount = z.infer<typeof facetCountSchema>;
export type BrainOverviewList = z.infer<typeof brainOverviewListSchema>;
export type BrainDetail = z.infer<typeof brainDetailSchema>;
export type Membership = z.infer<typeof membershipSchema>;
export type MembershipList = z.infer<typeof membershipListSchema>;
export type BrainConfig = z.infer<typeof brainConfigSchema>;
