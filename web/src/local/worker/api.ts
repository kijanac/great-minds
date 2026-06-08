import type { ListSourcesQuery, SourceDocumentPage } from "../schema/source";
import type { CreateVaultCommand, UpdateVaultCommand, Vault } from "../schema/vault";
import type { VaultSettings } from "../schema/vault-settings";
import type { Workspace } from "../schema/workspace";

export interface LocalApi {
  ensureWorkspace(): Promise<Workspace>;
  listVaults(): Promise<Vault[]>;
  getVaultSettings(vaultId: string): Promise<VaultSettings>;
  listSources(query: ListSourcesQuery): Promise<SourceDocumentPage>;
  createVault(command: CreateVaultCommand): Promise<Workspace>;
  updateVault(command: UpdateVaultCommand): Promise<Workspace>;
  switchVault(vaultId: string): Promise<Workspace>;
}
