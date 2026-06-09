import { createInsertSchema, createSelectSchema } from "drizzle-orm/zod";
import { z } from "zod";
import { sourceDocuments } from "../db/schema.js";
import { PaginationSchema, pageSchema } from "./pagination.js";
import { SourceDocumentIdSchema, VaultIdSchema } from "./ids.js";

export const SourceDocumentSchema = createSelectSchema(sourceDocuments, {
  derivedExtras: z.record(z.string(), z.unknown()),
}).extend({
  id: SourceDocumentIdSchema,
  vaultId: VaultIdSchema,
});

export const SourceDocumentUpsertSchema = createInsertSchema(sourceDocuments, {
  derivedExtras: z.record(z.string(), z.unknown()).optional(),
})
  .omit({ id: true, vaultId: true, createdAt: true, updatedAt: true })
  .extend({
    filePath: z.string().trim().min(1),
    fileHash: z.string().trim().min(1),
    bodyHash: z.string().trim().min(1),
    sourceType: z.string().trim().min(1).default("document"),
  });

export const SourceListQuerySchema = PaginationSchema.extend({
  sourceType: z.string().trim().min(1).optional(),
  search: z.string().trim().optional(),
});

export const SourceTypeFacetSchema = z.object({
  value: z.string(),
  count: z.number().int().nonnegative(),
});

export const SourceDocumentSummarySchema = SourceDocumentSchema.pick({
  filePath: true,
  sourceType: true,
  title: true,
  author: true,
  publishedDate: true,
  url: true,
  origin: true,
  genre: true,
  precis: true,
  tags: true,
  derivedExtras: true,
  updatedAt: true,
});

export const SourceDocumentPageSchema = pageSchema(SourceDocumentSummarySchema).extend({
  facets: z.object({ sourceTypes: z.array(SourceTypeFacetSchema) }),
});

export type SourceDocument = z.infer<typeof SourceDocumentSchema>;
export type SourceDocumentUpsert = z.infer<typeof SourceDocumentUpsertSchema>;
export type SourceListQuery = z.infer<typeof SourceListQuerySchema>;
export type SourceDocumentSummary = z.infer<typeof SourceDocumentSummarySchema>;
export type SourceDocumentPage = z.infer<typeof SourceDocumentPageSchema>;
