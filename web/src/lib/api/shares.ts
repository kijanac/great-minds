import { z } from "zod";

import { apiFetch, publicApiFetch, readJson } from "./client";

export const shareSubjectKindSchema = z.enum(["session", "reference"]);
export type ShareSubjectKind = z.infer<typeof shareSubjectKindSchema>;

export const shareOverviewSchema = z.object({
  id: z.string(),
  token: z.string(),
  subject_kind: shareSubjectKindSchema,
  subject_id: z.string(),
  created_by: z.string(),
  include_annotations: z.boolean(),
  created_at: z.string(),
  expires_at: z.string().nullable(),
  revoked_at: z.string().nullable(),
});
export type ShareOverview = z.infer<typeof shareOverviewSchema>;

export const shareCreateResultSchema = z.object({
  share: shareOverviewSchema,
  created: z.boolean(),
});
export type ShareCreateResult = z.infer<typeof shareCreateResultSchema>;

export const sharedSessionDetailSchema = z.object({
  subject_kind: z.literal("session"),
  title: z.string(),
  markdown: z.string(),
  created_at: z.string(),
});
export type SharedSessionDetail = z.infer<typeof sharedSessionDetailSchema>;

export const sharedReferenceDetailSchema = z.object({
  subject_kind: z.literal("reference"),
  title: z.string().nullable(),
  markdown: z.string(),
  origin: z.string().nullable(),
  created_at: z.string(),
});
export type SharedReferenceDetail = z.infer<typeof sharedReferenceDetailSchema>;

export const sharedShareDetailSchema = z.discriminatedUnion("subject_kind", [
  sharedSessionDetailSchema,
  sharedReferenceDetailSchema,
]);
export type SharedShareDetail = z.infer<typeof sharedShareDetailSchema>;

const errorDetailSchema = z.object({ detail: z.string() });

async function responseError(response: Response, fallback: string): Promise<Error> {
  const parsed = errorDetailSchema.safeParse(await response.json().catch(() => null));
  return new Error(parsed.success ? parsed.data.detail : fallback);
}

export interface CreateShareInput {
  subject_kind: ShareSubjectKind;
  subject_id: string;
}

export type ResolveShareResult = { status: "ok"; share: SharedShareDetail } | { status: "gone" };

export async function createShare(input: CreateShareInput): Promise<ShareCreateResult> {
  const response = await apiFetch("/shares", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw await responseError(response, "Failed to create share link");
  return readJson(response, shareCreateResultSchema);
}

export async function listShares(): Promise<ShareOverview[]> {
  const response = await apiFetch("/shares");
  if (!response.ok) throw await responseError(response, "Failed to list shares");
  return readJson(response, z.array(shareOverviewSchema));
}

export async function deleteShare(shareId: string): Promise<void> {
  const response = await apiFetch(`/shares/${shareId}`, { method: "DELETE" });
  if (!response.ok) throw await responseError(response, "Failed to revoke share");
}

export async function resolveShare(token: string): Promise<ResolveShareResult> {
  const response = await publicApiFetch(`/public/shares/${encodeURIComponent(token)}`);
  if (response.status === 404) return { status: "gone" };
  if (!response.ok) throw await responseError(response, "Failed to resolve share");
  return { status: "ok", share: await readJson(response, sharedShareDetailSchema) };
}
