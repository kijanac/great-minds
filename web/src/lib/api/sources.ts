import { z } from "zod";

import { apiFetch, vaultPath, readJson } from "./client";
import {
  facetedPaginatedSchema,
  facetCountSchema,
  proposalSchema,
  type FacetCount,
  type Proposal,
} from "./schemas";

const sourceDocumentSummarySchema = z.object({
  file_path: z.string(),
  source_type: z.string(),
  title: z.string().nullable(),
  author: z.string().nullable(),
  published_date: z.string().nullable(),
  url: z.string().nullable(),
  origin: z.string().nullable(),
  genre: z.string().nullable(),
  precis: z.string().nullable(),
  tags: z.array(z.string()),
  derived_extras: z.record(z.string(), z.unknown()),
  updated_at: z.string().nullable(),
});

const sourceDocumentFacetsSchema = z.object({
  source_types: z.array(facetCountSchema),
});

const sourceDocumentPageSchema = facetedPaginatedSchema(
  sourceDocumentSummarySchema,
  sourceDocumentFacetsSchema,
);

export type SourceDocumentSummary = z.infer<typeof sourceDocumentSummarySchema>;
export type SourceTypeFacet = FacetCount;
export type SourceDocumentPage = z.infer<typeof sourceDocumentPageSchema>;

export async function fetchSourceDocuments(params?: {
  source_type?: string;
  search?: string;
  tag?: string;
  limit?: number;
  offset?: number;
}): Promise<SourceDocumentPage> {
  const query = new URLSearchParams();
  if (params?.source_type) query.set("source_type", params.source_type);
  if (params?.search) query.set("search", params.search);
  if (params?.tag) query.set("tag", params.tag);
  if (params?.limit !== undefined) query.set("limit", String(params.limit));
  if (params?.offset !== undefined) query.set("offset", String(params.offset));

  const qs = query.toString();
  const path = vaultPath(`/raw/sources${qs ? `?${qs}` : ""}`);
  const res = await apiFetch(path);
  if (!res.ok) throw new Error("Failed to fetch raw sources");
  return readJson(res, sourceDocumentPageSchema);
}

export async function deleteSourceDocument(filePath: string): Promise<void> {
  const res = await apiFetch(vaultPath(`/raw/sources/${encodeSourcePath(filePath)}`), {
    method: "DELETE",
  });
  if (!res.ok) throw new Error("Failed to delete source");
}

export async function requestSourceDeletion(filePath: string): Promise<Proposal> {
  const res = await apiFetch(
    vaultPath(`/raw/sources/${encodeSourcePath(filePath)}/deletion-request`),
    { method: "POST" },
  );
  if (!res.ok) throw new Error("Failed to request source deletion");
  return readJson(res, proposalSchema);
}

function encodeSourcePath(filePath: string): string {
  return filePath
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}
