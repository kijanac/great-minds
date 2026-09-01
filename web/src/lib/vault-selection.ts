const VAULT_KEY = "vault_id";

const announce = () => window.dispatchEvent(new Event("auth:changed"));

export function getVaultId(): string | null {
  return localStorage.getItem(VAULT_KEY);
}

export function storeVaultId(vaultId: string): void {
  localStorage.setItem(VAULT_KEY, vaultId);
  announce();
}

export function clearVaultId(): void {
  localStorage.removeItem(VAULT_KEY);
  announce();
}
