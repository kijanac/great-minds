import { apiFetch, readJson } from "./client";
import {
  brainConfigSchema,
  brainDetailSchema,
  draftHintResponseSchema,
  membershipListSchema,
  membershipSchema,
  type BrainConfig,
  type BrainDetail,
  type Membership,
} from "./schemas";

export type { BrainConfig, BrainDetail, Membership };

export async function getBrainDetail(brainId: string): Promise<BrainDetail> {
  const res = await apiFetch(`/brains/${brainId}`);
  if (!res.ok) throw new Error("Failed to fetch project details");
  return readJson(res, brainDetailSchema);
}

export async function listMembers(brainId: string): Promise<Membership[]> {
  const res = await apiFetch(`/brains/${brainId}/members`);
  if (!res.ok) throw new Error("Failed to fetch members");
  const parsed = await readJson(res, membershipListSchema);
  return parsed.items;
}

export async function inviteMember(
  brainId: string,
  email: string,
  role: string = "editor",
): Promise<Membership> {
  const res = await apiFetch(`/brains/${brainId}/members`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, role }),
  });
  if (!res.ok) throw new Error("Failed to invite member");
  return readJson(res, membershipSchema);
}

export async function updateMemberRole(
  brainId: string,
  userId: string,
  role: string,
): Promise<Membership> {
  const res = await apiFetch(`/brains/${brainId}/members/${userId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role }),
  });
  if (!res.ok) throw new Error("Failed to update member role");
  return readJson(res, membershipSchema);
}

export async function removeMember(brainId: string, userId: string): Promise<void> {
  const res = await apiFetch(`/brains/${brainId}/members/${userId}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error("Failed to remove member");
}

export async function getBrainConfig(brainId: string): Promise<BrainConfig> {
  const res = await apiFetch(`/brains/${brainId}/config`);
  if (!res.ok) throw new Error("Failed to fetch project config");
  return readJson(res, brainConfigSchema);
}

export async function updateBrainConfig(
  brainId: string,
  patch: Partial<BrainConfig>,
): Promise<BrainConfig> {
  const res = await apiFetch(`/brains/${brainId}/config`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error("Failed to update project config");
  return readJson(res, brainConfigSchema);
}

export async function draftThematicHint(description: string): Promise<string> {
  const res = await apiFetch(`/brains/draft-hint`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ description }),
  });
  if (!res.ok) throw new Error("Failed to draft hint");
  const parsed = await readJson(res, draftHintResponseSchema);
  return parsed.thematic_hint;
}
