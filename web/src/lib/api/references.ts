import { z } from "zod";

import { apiFetch, paginationParams, readJson, responseError } from "./client";
import { ingestedDocumentSchema, paginatedSchema } from "./schemas";

export const referenceOverviewSchema = z.object({
  id: z.string(),
  file_path: z.string(),
  title: z.string().nullable(),
  url: z.string().nullable(),
  origin: z.string().nullable(),
  author: z.string().nullable(),
  published: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

const referencePageSchema = paginatedSchema(referenceOverviewSchema);

export type ReferenceOverview = z.infer<typeof referenceOverviewSchema>;
export type ReferencePage = z.infer<typeof referencePageSchema>;
export type IngestedDocument = z.infer<typeof ingestedDocumentSchema>;

export async function listReferences(
  params?: { limit?: number; offset?: number },
  signal?: AbortSignal,
): Promise<ReferencePage> {
  const query = paginationParams(params);
  const qs = query.toString();
  const response = await apiFetch(`/me/refs${qs ? `?${qs}` : ""}`, { signal });
  if (!response.ok) throw await responseError(response, "Failed to load reading room");
  return readJson(response, referencePageSchema);
}

export async function createReference(url: string): Promise<ReferenceOverview> {
  const response = await apiFetch("/me/refs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  if (!response.ok) throw await responseError(response, "Failed to open external article");
  return readJson(response, referenceOverviewSchema);
}

export async function promoteReference(vaultId: string, path: string): Promise<IngestedDocument> {
  const response = await apiFetch(`/vaults/${vaultId}/ingest/reference`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!response.ok) throw await responseError(response, "Failed to add reference to vault");
  return readJson(response, ingestedDocumentSchema);
}

export async function renameReference(
  path: string,
  title: string | null,
): Promise<ReferenceOverview> {
  const response = await apiFetch(`/me/refs/${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  if (!response.ok) throw await responseError(response, "Failed to rename reference");
  return readJson(response, referenceOverviewSchema);
}
