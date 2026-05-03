import { apiFetch, readJson } from "./client";
import {
  vaultConfigSchema,
  vaultDetailSchema,
  draftHintResponseSchema,
  membershipListSchema,
  membershipSchema,
  type VaultConfig,
  type VaultDetail,
  type Membership,
} from "./schemas";

export type { VaultConfig, VaultDetail, Membership };

export async function getVaultDetail(vaultId: string): Promise<VaultDetail> {
  const res = await apiFetch(`/vaults/${vaultId}`);
  if (!res.ok) throw new Error("Failed to fetch project details");
  return readJson(res, vaultDetailSchema);
}

export async function listMembers(vaultId: string): Promise<Membership[]> {
  const res = await apiFetch(`/vaults/${vaultId}/members`);
  if (!res.ok) throw new Error("Failed to fetch members");
  const parsed = await readJson(res, membershipListSchema);
  return parsed.items;
}

export async function inviteMember(
  vaultId: string,
  email: string,
  role: string = "editor",
): Promise<Membership> {
  const res = await apiFetch(`/vaults/${vaultId}/members`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, role }),
  });
  if (!res.ok) throw new Error("Failed to invite member");
  return readJson(res, membershipSchema);
}

export async function updateMemberRole(
  vaultId: string,
  userId: string,
  role: string,
): Promise<Membership> {
  const res = await apiFetch(`/vaults/${vaultId}/members/${userId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role }),
  });
  if (!res.ok) throw new Error("Failed to update member role");
  return readJson(res, membershipSchema);
}

export async function removeMember(vaultId: string, userId: string): Promise<void> {
  const res = await apiFetch(`/vaults/${vaultId}/members/${userId}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error("Failed to remove member");
}

export async function getVaultConfig(vaultId: string): Promise<VaultConfig> {
  const res = await apiFetch(`/vaults/${vaultId}/config`);
  if (!res.ok) throw new Error("Failed to fetch project config");
  return readJson(res, vaultConfigSchema);
}

export async function updateVaultConfig(
  vaultId: string,
  patch: Partial<VaultConfig>,
): Promise<VaultConfig> {
  const res = await apiFetch(`/vaults/${vaultId}/config`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error("Failed to update project config");
  return readJson(res, vaultConfigSchema);
}

export async function draftThematicHint(description: string): Promise<string> {
  const res = await apiFetch(`/vaults/draft-hint`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ description }),
  });
  if (!res.ok) throw new Error("Failed to draft hint");
  const parsed = await readJson(res, draftHintResponseSchema);
  return parsed.thematic_hint;
}
