import { z } from "zod";

import { apiFetch, brainPath, readJson } from "./client";
import {
  facetedPaginatedSchema,
  facetCountSchema,
  type FacetCount,
} from "./schemas";

const sourceDocumentSummarySchema = z.object({
  file_path: z.string(),
  compiled: z.boolean(),
  metadata: z.object({
    title: z.string(),
    author: z.string().nullable(),
    published_date: z.string().nullable(),
    url: z.string().nullable(),
    origin: z.string().nullable(),
    genre: z.string().nullable(),
    precis: z.string().nullable(),
    source_type: z.string().nullable(),
    tags: z.array(z.string()),
    extra_metadata: z.record(z.string(), z.unknown()),
  }),
  updated_at: z.string().nullable(),
});

const sourceDocumentFacetsSchema = z.object({
  content_types: z.array(facetCountSchema),
});

const sourceDocumentPageSchema = facetedPaginatedSchema(
  sourceDocumentSummarySchema,
  sourceDocumentFacetsSchema,
);

export type SourceDocumentSummary = z.infer<typeof sourceDocumentSummarySchema>;
export type ContentTypeFacet = FacetCount;
export type SourceDocumentPage = z.infer<typeof sourceDocumentPageSchema>;

export async function fetchSourceDocuments(params?: {
  content_type?: string;
  search?: string;
  compiled?: boolean;
  limit?: number;
  offset?: number;
}): Promise<SourceDocumentPage> {
  const query = new URLSearchParams();
  if (params?.content_type) query.set("content_type", params.content_type);
  if (params?.search) query.set("search", params.search);
  if (params?.compiled !== undefined) query.set("compiled", String(params.compiled));
  if (params?.limit !== undefined) query.set("limit", String(params.limit));
  if (params?.offset !== undefined) query.set("offset", String(params.offset));

  const qs = query.toString();
  const path = brainPath(`/raw/sources${qs ? `?${qs}` : ""}`);
  const res = await apiFetch(path);
  if (!res.ok) throw new Error("Failed to fetch raw sources");
  return readJson(res, sourceDocumentPageSchema);
}
