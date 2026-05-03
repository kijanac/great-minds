import { z } from "zod";

import {
  vaultOverviewListSchema,
  vaultOverviewSchema,
  type VaultOverview,
} from "./schemas";

export type { VaultOverview } from "./schemas";

const API_BASE = import.meta.env.VITE_API_BASE || "/api";

export async function readJson<T>(res: Response, schema: z.ZodType<T>): Promise<T> {
  return schema.parse(await res.json());
}

const authTokensSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
});

function getAccessToken(): string | null {
  return localStorage.getItem("access_token");
}

function getRefreshToken(): string | null {
  return localStorage.getItem("refresh_token");
}

export function getVaultId(): string | null {
  return localStorage.getItem("vault_id");
}

function storeTokens(accessToken: string, refreshToken: string) {
  localStorage.setItem("access_token", accessToken);
  localStorage.setItem("refresh_token", refreshToken);
}

export function storeVaultId(vaultId: string) {
  localStorage.setItem("vault_id", vaultId);
  window.dispatchEvent(new Event("auth:changed"));
}

export function clearTokens() {
  localStorage.removeItem("access_token");
  localStorage.removeItem("refresh_token");
  localStorage.removeItem("vault_id");
  window.dispatchEvent(new Event("auth:changed"));
}

let refreshInFlight: Promise<string | null> | null = null;

async function doRefresh(): Promise<string | null> {
  const rt = getRefreshToken();
  if (!rt) return null;

  const res = await fetch(`${API_BASE}/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: rt }),
  });

  if (!res.ok) {
    clearTokens();
    return null;
  }

  const data = await readJson(res, authTokensSchema);
  storeTokens(data.access_token, data.refresh_token);
  return data.access_token;
}

function refreshAccessToken(): Promise<string | null> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = doRefresh().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

async function resolveDefaultVault(): Promise<string> {
  const res = await apiFetch("/vaults");
  if (!res.ok) throw new Error("Failed to fetch vaults");

  const vaults = await readJson(res, vaultOverviewListSchema);
  if (!vaults.items.length) throw new Error("No vaults found");
  return vaults.items[0].id;
}

export function vaultPath(path: string): string {
  const vaultId = getVaultId();
  if (!vaultId) throw new Error("No vault selected");
  return `/vaults/${vaultId}${path}`;
}

export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const url = new URL(`${API_BASE}${path}`, location.origin);

  const headers = new Headers(init?.headers);
  const token = getAccessToken();
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  let res = await fetch(url, { ...init, headers });

  if (res.status === 401) {
    const newToken = await refreshAccessToken();
    if (newToken) {
      headers.set("Authorization", `Bearer ${newToken}`);
      res = await fetch(url, { ...init, headers });
    }
  }

  return res;
}

export async function ensureVaultId(): Promise<void> {
  if (getVaultId()) return;
  if (!getAccessToken()) return;
  const vaultId = await resolveDefaultVault();
  storeVaultId(vaultId);
}

export async function loginWithCode(email: string, code: string): Promise<void> {
  const res = await fetch(`${API_BASE}/auth/verify-code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, code }),
  });
  if (!res.ok) throw new Error("Invalid or expired code");

  const data = await readJson(res, authTokensSchema);
  storeTokens(data.access_token, data.refresh_token);

  try {
    const vaultId = await resolveDefaultVault();
    storeVaultId(vaultId);
  } catch {
    throw new Error("Signed in, but failed to load your workspace. Please refresh.");
  }
}

export async function fetchVaults(): Promise<VaultOverview[]> {
  const res = await apiFetch("/vaults");
  if (!res.ok) throw new Error("Failed to fetch vaults");
  const parsed = await readJson(res, vaultOverviewListSchema);
  return parsed.items;
}

export interface CreateVaultInput {
  name: string;
  thematic_hint?: string;
  kinds?: string[];
}

export async function createVault(input: CreateVaultInput): Promise<VaultOverview> {
  const res = await apiFetch("/vaults", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error("Failed to create project");
  return readJson(res, vaultOverviewSchema);
}

export async function requestCode(email: string): Promise<void> {
  const res = await fetch(`${API_BASE}/auth/request-code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) throw new Error("Failed to send code");
}
