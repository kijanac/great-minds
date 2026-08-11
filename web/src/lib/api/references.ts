import { z } from "zod";

import { apiFetch, readJson } from "./client";
import { paginatedSchema } from "./schemas";

export const referenceOverviewSchema = z.object({
  id: z.string(),
  file_path: z.string(),
  title: z.string().nullable(),
  url: z.string().nullable(),
  origin: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

const referencePageSchema = paginatedSchema(referenceOverviewSchema);
const ingestedDocumentSchema = z.object({ file_path: z.string() });
const errorDetailSchema = z.object({ detail: z.string() });

export type ReferenceOverview = z.infer<typeof referenceOverviewSchema>;
export type ReferencePage = z.infer<typeof referencePageSchema>;
export type IngestedDocument = z.infer<typeof ingestedDocumentSchema>;

async function responseError(response: Response, fallback: string): Promise<Error> {
  const parsed = errorDetailSchema.safeParse(await response.json().catch(() => null));
  return new Error(parsed.success ? parsed.data.detail : fallback);
}

export async function listReferences(
  params?: { limit?: number; offset?: number },
  signal?: AbortSignal,
): Promise<ReferencePage> {
  const query = new URLSearchParams();
  if (params?.limit !== undefined) query.set("limit", String(params.limit));
  if (params?.offset !== undefined) query.set("offset", String(params.offset));
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
