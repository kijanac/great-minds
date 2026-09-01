import {
  Email,
  InvitedMemberRole,
  MemberRole,
  Uuid,
  type MemberWithEmail,
  type Vault,
  type VaultConfig,
  type VaultConfigUpdate,
  type VaultCreate,
  type VaultDetail,
} from "@great-minds/domain";
import { Effect, Schema } from "effect";

import { api, run } from "./app";

export type { VaultConfig, VaultConfigUpdate, VaultDetail };
export type Membership = MemberWithEmail;
export type VaultOverview = Vault;
export type CreateVaultInput = VaultCreate;

const uuid = Schema.decodeSync(Uuid);
const email = Schema.decodeSync(Email);
const firstPage = { limit: 50, offset: 0 } as const;

function memberRole(role: string): MemberRole {
  if (Schema.is(MemberRole)(role)) return role;
  throw new Error(`Unknown role: ${role}`);
}

function invitedRole(role: string): InvitedMemberRole {
  if (Schema.is(InvitedMemberRole)(role)) return role;
  throw new Error(`Unknown role: ${role}`);
}

export async function fetchVaults(): Promise<readonly VaultOverview[]> {
  const page = await run(api.vaults.listVaults({ query: firstPage }));
  return page.items;
}

export async function createVault(input: CreateVaultInput): Promise<VaultOverview> {
  return run(api.vaults.createVault({ payload: input }));
}

export async function getVaultDetail(vaultId: string): Promise<VaultDetail> {
  return run(api.vaults.getVault({ params: { vault_id: uuid(vaultId) } }));
}

export async function listMembers(vaultId: string): Promise<readonly Membership[]> {
  const page = await run(
    api.vaults.listVaultMembers({ params: { vault_id: uuid(vaultId) }, query: firstPage }),
  );
  return page.items;
}

export async function inviteMember(
  vaultId: string,
  address: string,
  role: string = "editor",
): Promise<Membership> {
  return run(
    api.vaults.inviteVaultMember({
      params: { vault_id: uuid(vaultId) },
      payload: { email: email(address), role: invitedRole(role) },
    }),
  );
}

export async function updateMemberRole(
  vaultId: string,
  userId: string,
  role: string,
): Promise<Membership> {
  return run(
    api.vaults.updateVaultMember({
      params: { vault_id: uuid(vaultId), member_user_id: uuid(userId) },
      payload: { role: memberRole(role) },
    }),
  );
}

export async function removeMember(vaultId: string, userId: string): Promise<void> {
  return run(
    api.vaults.removeVaultMember({
      params: { vault_id: uuid(vaultId), member_user_id: uuid(userId) },
    }),
  );
}

export async function transferOwnership(vaultId: string, newOwnerUserId: string): Promise<void> {
  return run(
    api.vaults.transferVaultOwnership({
      params: { vault_id: uuid(vaultId) },
      payload: { new_owner_user_id: uuid(newOwnerUserId) },
    }),
  );
}

export async function deleteVault(vaultId: string): Promise<void> {
  return run(api.vaults.deleteVault({ params: { vault_id: uuid(vaultId) } }));
}

export async function getVaultConfig(vaultId: string): Promise<VaultConfig> {
  return run(api.vaults.getVaultConfig({ params: { vault_id: uuid(vaultId) } }));
}

export async function updateVaultConfig(
  vaultId: string,
  patch: VaultConfigUpdate,
): Promise<VaultConfig> {
  return run(api.vaults.updateVaultConfig({ params: { vault_id: uuid(vaultId) }, payload: patch }));
}

export async function draftThematicHint(description: string): Promise<string> {
  return run(
    api.vaults
      .draftVaultHint({ payload: { description } })
      .pipe(Effect.map((response) => response.thematic_hint)),
  );
}
