import { z } from "zod";

import { apiFetch, readJson } from "./client";
import { brainDetailSchema, membershipSchema, type BrainDetail, type Membership } from "./schemas";

export type { BrainDetail, Membership };

export async function getBrainDetail(brainId: string): Promise<BrainDetail> {
  const res = await apiFetch(`/brains/${brainId}`);
  if (!res.ok) throw new Error("Failed to fetch project details");
  return readJson(res, brainDetailSchema);
}

export async function listMembers(brainId: string): Promise<Membership[]> {
  const res = await apiFetch(`/brains/${brainId}/members`);
  if (!res.ok) throw new Error("Failed to fetch members");
  return readJson(res, z.array(membershipSchema));
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
