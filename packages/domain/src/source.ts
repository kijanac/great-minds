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

const SafeSourceDestPathSchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    (value) =>
      !value.includes("\\") &&
      !value.startsWith("/") &&
      !value.split("/").includes("..") &&
      value !== ".",
    "destPath must be a relative path under raw/docs",
  );

const SafeSourceFilePathSchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    (value) => {
      const parts = value.split("/");
      return (
        !value.includes("\\") &&
        !value.startsWith("/") &&
        !parts.includes("..") &&
        parts.length >= 3 &&
        parts[0] === "raw" &&
        value.endsWith(".md")
      );
    },
    "filePath must be a relative raw/*.md source path",
  );

export const SourceDocumentCreateSchema = z.object({
  destPath: SafeSourceDestPathSchema,
  content: z.string().min(1),
  sourceType: z.string().trim().min(1).default("document"),
  url: z.string().trim().url().optional(),
  origin: z.string().trim().min(1).optional(),
  clientHash: z.string().trim().min(1).optional(),
});

export const SourceListQuerySchema = PaginationSchema.extend({
  sourceType: z.string().trim().min(1).optional(),
  search: z.string().trim().optional(),
});

export const SourceDocumentDeleteSchema = z.object({
  filePath: SafeSourceFilePathSchema,
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
export type SourceDocumentCreate = z.infer<typeof SourceDocumentCreateSchema>;
export type SourceDocumentDelete = z.infer<typeof SourceDocumentDeleteSchema>;
export type SourceListQuery = z.infer<typeof SourceListQuerySchema>;
export type SourceDocumentSummary = z.infer<typeof SourceDocumentSummarySchema>;
export type SourceDocumentPage = z.infer<typeof SourceDocumentPageSchema>;
