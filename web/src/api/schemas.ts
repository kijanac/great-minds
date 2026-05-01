import { z } from "zod";

export const sourceRefSchema = z.object({
  label: z.string(),
  type: z.enum(["article", "raw", "search"]),
  title: z.string().nullable().optional(),
  thinking: z.string().optional(),
});

export const thinkingBlockSchema = z.object({
  sources: z.array(sourceRefSchema),
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

export const apiKeySchema = z.object({
  id: z.string(),
  label: z.string(),
  revoked: z.boolean(),
  created_at: z.string(),
});

export const apiKeyCreatedSchema = apiKeySchema.extend({
  raw_key: z.string(),
});

export const proposalStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
]);

export const proposalOverviewSchema = z.object({
  id: z.string(),
  brain_id: z.string(),
  status: proposalStatusSchema,
  title: z.string().nullable(),
  content_type: z.string(),
  created_at: z.string(),
});

export const proposalSchema = proposalOverviewSchema.extend({
  user_id: z.string(),
  author: z.string().nullable(),
  reviewed_by: z.string().nullable(),
  reviewed_at: z.string().nullable(),
});

export const proposalListSchema = paginatedSchema(proposalOverviewSchema);

export type SourceRef = z.infer<typeof sourceRefSchema>;
export type ThinkingBlock = z.infer<typeof thinkingBlockSchema>;
export type BrainOverview = z.infer<typeof brainOverviewSchema>;
export type PageInfo = z.infer<typeof pageInfoSchema>;
export type FacetCount = z.infer<typeof facetCountSchema>;
export type BrainOverviewList = z.infer<typeof brainOverviewListSchema>;
export type BrainDetail = z.infer<typeof brainDetailSchema>;
export type Membership = z.infer<typeof membershipSchema>;
export type MembershipList = z.infer<typeof membershipListSchema>;
export type BrainConfig = z.infer<typeof brainConfigSchema>;
export type ApiKey = z.infer<typeof apiKeySchema>;
export type ApiKeyCreated = z.infer<typeof apiKeyCreatedSchema>;
export type ProposalStatus = z.infer<typeof proposalStatusSchema>;
export type ProposalOverview = z.infer<typeof proposalOverviewSchema>;
export type Proposal = z.infer<typeof proposalSchema>;
export type ProposalList = z.infer<typeof proposalListSchema>;
