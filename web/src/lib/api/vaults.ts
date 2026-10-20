import {
  Email,
  InvitedMemberRole,
  MemberRole,
  type MemberWithEmail,
  type Vault,
  type VaultConfig,
  type VaultConfigUpdate,
  type VaultCreate,
  type VaultDetail,
  type Uuid,
} from "@great-minds/domain";
import { Effect } from "effect";

import { api, run } from "./app";
import { decodeInput } from "./runtime";

export type { VaultConfig, VaultConfigUpdate, VaultDetail };
export type Membership = MemberWithEmail;
export type VaultOverview = Vault;
export type CreateVaultInput = VaultCreate;

const firstPage = { limit: 50, offset: 0 } as const;

export function fetchVaults(signal?: AbortSignal): Promise<readonly VaultOverview[]> {
  return run(
    Effect.gen(function* () {
      const first = yield* api.vaults.listVaults({ query: firstPage });
      const items = [...first.items];
      for (let offset = items.length; offset < first.pagination.total;) {
        const page = yield* api.vaults.listVaults({ query: { limit: firstPage.limit, offset } });
        if (page.items.length === 0) break;
        items.push(...page.items);
        offset += page.items.length;
      }
      return items;
    }),
    { signal },
  );
}

export function createVault(input: CreateVaultInput): Promise<VaultOverview> {
  return run(api.vaults.createVault({ payload: input }));
}

export function getVaultDetail(vaultId: Uuid): Promise<VaultDetail> {
  return run(api.vaults.getVault({ params: { vault_id: vaultId } }));
}

export async function listMembers(vaultId: Uuid): Promise<readonly Membership[]> {
  const page = await run(
    api.vaults.listVaultMembers({ params: { vault_id: vaultId }, query: firstPage }),
  );
  return page.items;
}

export function inviteMember(
  vaultId: Uuid,
  address: string,
  role: string = "editor",
): Promise<Membership> {
  return run(
    Effect.gen(function* () {
      const email = yield* decodeInput(Email, address);
      const invitedRole = yield* decodeInput(InvitedMemberRole, role);
      return yield* api.vaults.inviteVaultMember({
        params: { vault_id: vaultId },
        payload: { email, role: invitedRole },
      });
    }),
  );
}

export function updateMemberRole(vaultId: Uuid, userId: Uuid, role: string): Promise<Membership> {
  return run(
    Effect.gen(function* () {
      const memberRole = yield* decodeInput(MemberRole, role);
      return yield* api.vaults.updateVaultMember({
        params: { vault_id: vaultId, member_user_id: userId },
        payload: { role: memberRole },
      });
    }),
  );
}

export function removeMember(vaultId: Uuid, userId: Uuid): Promise<void> {
  return run(
    api.vaults.removeVaultMember({
      params: { vault_id: vaultId, member_user_id: userId },
    }),
  );
}

export function transferOwnership(vaultId: Uuid, newOwnerUserId: Uuid): Promise<void> {
  return run(
    api.vaults.transferVaultOwnership({
      params: { vault_id: vaultId },
      payload: { new_owner_user_id: newOwnerUserId },
    }),
  );
}

export function deleteVault(vaultId: Uuid): Promise<void> {
  return run(api.vaults.deleteVault({ params: { vault_id: vaultId } }));
}

export function getVaultConfig(vaultId: Uuid): Promise<VaultConfig> {
  return run(api.vaults.getVaultConfig({ params: { vault_id: vaultId } }));
}

export function updateVaultConfig(vaultId: Uuid, patch: VaultConfigUpdate): Promise<VaultConfig> {
  return run(api.vaults.updateVaultConfig({ params: { vault_id: vaultId }, payload: patch }));
}

export function draftThematicHint(description: string): Promise<string> {
  return run(
    api.vaults
      .draftVaultHint({ payload: { description } })
      .pipe(Effect.map((response) => response.thematic_hint)),
  );
}
