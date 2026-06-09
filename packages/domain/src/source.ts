import { createInsertSchema, createSelectSchema } from "drizzle-orm/zod";
import { z } from "zod";
import { sourceDocuments } from "@great-minds/db/schema";
import { PaginationSchema, pageSchema } from "./pagination.js";
import { VaultIdSchema } from "./vault.js";

export const SourceDocumentIdSchema = z.string().uuid().brand<"SourceDocumentId">();

export const SourceDocumentSchema = createSelectSchema(sourceDocuments, {
  id: SourceDocumentIdSchema,
  vaultId: VaultIdSchema,
  derivedExtras: z.record(z.string(), z.unknown()),
});

export const SourceDocumentUpsertSchema = createInsertSchema(sourceDocuments, {
  filePath: (schema) => schema.trim().min(1),
  fileHash: (schema) => schema.trim().min(1),
  bodyHash: (schema) => schema.trim().min(1),
  sourceType: (schema) => schema.trim().min(1).default("document"),
  derivedExtras: z.record(z.string(), z.unknown()).optional(),
}).pick({
  filePath: true,
  fileHash: true,
  bodyHash: true,
  clientHash: true,
  etag: true,
  sourceType: true,
  url: true,
  origin: true,
  title: true,
  precis: true,
  author: true,
  publishedDate: true,
  genre: true,
  tags: true,
  derivedExtras: true,
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

export type SourceDocumentId = z.infer<typeof SourceDocumentIdSchema>;
export type SourceDocument = z.infer<typeof SourceDocumentSchema>;
export type SourceDocumentUpsert = z.infer<typeof SourceDocumentUpsertSchema>;
export type SourceListQuery = z.infer<typeof SourceListQuerySchema>;
export type SourceDocumentSummary = z.infer<typeof SourceDocumentSummarySchema>;
export type SourceDocumentPage = z.infer<typeof SourceDocumentPageSchema>;
