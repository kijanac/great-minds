import { createSelectSchema } from "drizzle-orm/zod";
import { z } from "zod";
import { sourceDocuments } from "../db/schema";

export type SourceDocument = typeof sourceDocuments.$inferSelect;
export const SourceDocumentSchema = createSelectSchema(sourceDocuments, {
  derivedExtras: z.record(z.string(), z.unknown()),
});

export const ListSourcesQuerySchema = z.object({
  sourceType: z.string().trim().min(1).optional(),
  search: z.string().trim().optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});

export type ListSourcesQuery = z.infer<typeof ListSourcesQuerySchema>;

export const SourceTypeFacetSchema = z.object({
  value: z.string(),
  count: z.number().int().nonnegative(),
});

export type SourceTypeFacet = z.infer<typeof SourceTypeFacetSchema>;

export const SourceDocumentSummarySchema = z.object({
  filePath: z.string(),
  sourceType: z.string(),
  title: z.string().nullable(),
  author: z.string().nullable(),
  publishedDate: z.string().nullable(),
  url: z.string().nullable(),
  origin: z.string().nullable(),
  genre: z.string().nullable(),
  precis: z.string().nullable(),
  tags: z.array(z.string()),
  derivedExtras: z.record(z.string(), z.unknown()),
  updatedAt: z.date(),
});

export type SourceDocumentSummary = z.infer<typeof SourceDocumentSummarySchema>;

export const SourceDocumentPageSchema = z.object({
  items: z.array(SourceDocumentSummarySchema),
  pagination: z.object({
    limit: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
  facets: z.object({
    sourceTypes: z.array(SourceTypeFacetSchema),
  }),
});

export type SourceDocumentPage = z.infer<typeof SourceDocumentPageSchema>;
