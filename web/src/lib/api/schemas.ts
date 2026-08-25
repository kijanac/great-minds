import { z } from "zod";

export const sourceRefSchema = z.object({
  label: z.string(),
  type: z.enum(["article", "raw", "search", "query", "links"]),
  document_id: z.string().nullable(),
  title: z.string().nullable(),
  // For searches: where the search ran.
  scope: z.enum(["kb", "web"]).nullable(),
  // For document-scoped searches: which document was searched.
  path: z.string().nullable(),
  // Transient reply-snapshot state used while a tool call is in flight.
  pending: z.boolean().optional(),
  // Backend ThinkingSource.thinking is `str | None`; always present, may be null.
  thinking: z.string().nullable(),
  // For content cards (article/raw): which chunk ranges the agent expanded,
  // and whether it read the whole document. Drive the context panel.
  ranges: z.array(z.object({ start: z.number(), end: z.number() })).optional(),
  full: z.boolean().optional(),
});

export const thinkingBlockSchema = z.object({
  sources: z.array(sourceRefSchema),
});

export const vaultSchema = z.object({
  id: z.string(),
  name: z.string(),
  owner_id: z.string(),
  created_at: z.string(),
  staged_uploads: z.boolean(),
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

export function facetedPaginatedSchema<T extends z.ZodTypeAny, F extends z.ZodTypeAny>(
  itemSchema: T,
  facetsSchema: F,
) {
  return paginatedSchema(itemSchema).extend({
    facets: facetsSchema,
  });
}

export const vaultPageSchema = paginatedSchema(vaultSchema).extend({
  roles: z.record(z.string(), z.string()),
});

export const vaultDetailSchema = vaultSchema.extend({
  role: z.string(),
  member_count: z.number(),
  article_count: z.number(),
});

export const membershipSchema = z.object({
  user_id: z.string(),
  email: z.string(),
  role: z.string(),
});

export const membershipListSchema = paginatedSchema(membershipSchema);

export const vaultConfigSchema = z.object({
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

export const passkeySchema = z.object({
  id: z.string(),
  name: z.string(),
  created_at: z.string(),
  last_used_at: z.string().nullable(),
  transports: z.array(z.enum(["ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb"])),
});

export const proposalStatusSchema = z.enum(["pending", "approved", "rejected"]);

export const proposalOverviewSchema = z.object({
  id: z.string(),
  vault_id: z.string(),
  status: proposalStatusSchema,
  title: z.string().nullable(),
  content_type: z.string(),
  created_at: z.string(),
});

export const proposalSchema = proposalOverviewSchema.extend({
  user_id: z.string(),
  author: z.string().nullable(),
  dest_path: z.string(),
  source_id: z.string(),
});

export const proposalListSchema = paginatedSchema(proposalOverviewSchema);

export type SourceRef = z.infer<typeof sourceRefSchema>;
export type ThinkingBlock = z.infer<typeof thinkingBlockSchema>;
export type Vault = z.infer<typeof vaultSchema>;
export type VaultPage = z.infer<typeof vaultPageSchema>;
export type VaultOverview = Vault;
export type VaultOverviewList = VaultPage;
export type PageInfo = z.infer<typeof pageInfoSchema>;
export type FacetCount = z.infer<typeof facetCountSchema>;
export type VaultDetail = z.infer<typeof vaultDetailSchema>;
export type Membership = z.infer<typeof membershipSchema>;
export type MembershipList = z.infer<typeof membershipListSchema>;
export type VaultConfig = z.infer<typeof vaultConfigSchema>;
export type ApiKey = z.infer<typeof apiKeySchema>;
export type ApiKeyCreated = z.infer<typeof apiKeyCreatedSchema>;
export type Passkey = z.infer<typeof passkeySchema>;
export type ProposalStatus = z.infer<typeof proposalStatusSchema>;
export type ProposalOverview = z.infer<typeof proposalOverviewSchema>;
export type Proposal = z.infer<typeof proposalSchema>;
export type ProposalList = z.infer<typeof proposalListSchema>;
