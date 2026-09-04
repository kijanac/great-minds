import { Uuid } from "@great-minds/domain";
import { Option, Schema } from "effect";

const VAULT_KEY = "vault_id";
const decodeVaultId = Schema.decodeOption(Uuid);

const announce = () => window.dispatchEvent(new Event("auth:changed"));

export function getVaultId(): Uuid | null {
  const stored = localStorage.getItem(VAULT_KEY);
  if (stored === null) return null;
  const decoded = decodeVaultId(stored);
  if (Option.isSome(decoded)) return decoded.value;
  clearVaultId();
  return null;
}

export function storeVaultId(vaultId: Uuid): void {
  localStorage.setItem(VAULT_KEY, vaultId);
  announce();
}

export function clearVaultId(): void {
  localStorage.removeItem(VAULT_KEY);
  announce();
}
