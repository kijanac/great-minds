import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";

import {
  vaultPageSchema as vaultOverviewListSchema,
  vaultSchema as vaultOverviewSchema,
  type VaultOverview,
} from "./schemas";

export type { VaultOverview } from "./schemas";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

const HOSTED_API_BASE = "https://great-minds-api.onrender.com/v1";
const AUTH_PERSISTED_KEY = "auth_persisted";
let accessTokenMemory: string | null = null;

function isTauriRuntime(): boolean {
  return (
    Boolean(window.__TAURI_INTERNALS__) ||
    location.hostname === "tauri.localhost" ||
    location.protocol === "tauri:"
  );
}

function defaultApiBase(): string {
  if (isTauriRuntime()) {
    return HOSTED_API_BASE;
  }
  return "/api";
}

const API_BASE = import.meta.env.VITE_API_BASE || defaultApiBase();

export async function readJson<T>(res: Response, schema: z.ZodType<T>): Promise<T> {
  return schema.parse(await res.json());
}

const authTokensSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
});

function getAccessToken(): string | null {
  return isTauriRuntime() ? accessTokenMemory : localStorage.getItem("access_token");
}

async function getRefreshToken(): Promise<string | null> {
  if (!isTauriRuntime()) return localStorage.getItem("refresh_token");
  try {
    return await invoke<string | null>("get_refresh_token");
  } catch (err) {
    console.warn("Failed to read refresh token from secure storage", err);
    return null;
  }
}

export function hasPersistedAuth(): boolean {
  if (!isTauriRuntime()) return Boolean(localStorage.getItem("refresh_token"));
  return localStorage.getItem(AUTH_PERSISTED_KEY) === "true";
}

export function getCurrentAccessToken(): string | null {
  return getAccessToken();
}

export function getVaultId(): string | null {
  return localStorage.getItem("vault_id");
}

async function storeTokens(accessToken: string, refreshToken: string): Promise<void> {
  if (isTauriRuntime()) {
    accessTokenMemory = accessToken;
    await invoke("store_refresh_token", { refreshToken });
    localStorage.setItem(AUTH_PERSISTED_KEY, "true");
    localStorage.removeItem("access_token");
    localStorage.removeItem("refresh_token");
    window.dispatchEvent(new Event("auth:changed"));
    return;
  }
  localStorage.setItem("access_token", accessToken);
  localStorage.setItem("refresh_token", refreshToken);
  window.dispatchEvent(new Event("auth:changed"));
}

export function storeVaultId(vaultId: string) {
  localStorage.setItem("vault_id", vaultId);
  window.dispatchEvent(new Event("auth:changed"));
}

export async function clearTokens(): Promise<void> {
  accessTokenMemory = null;
  localStorage.removeItem("access_token");
  localStorage.removeItem("refresh_token");
  localStorage.removeItem("vault_id");
  localStorage.removeItem(AUTH_PERSISTED_KEY);
  if (isTauriRuntime()) {
    try {
      await invoke("delete_refresh_token");
    } catch (err) {
      console.warn("Failed to delete refresh token from secure storage", err);
    }
  }
  window.dispatchEvent(new Event("auth:changed"));
}

let refreshInFlight: Promise<string | null> | null = null;

async function doRefresh(): Promise<string | null> {
  const rt = await getRefreshToken();
  if (!rt) return null;

  const res = await fetch(`${API_BASE}/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: rt }),
  });

  if (!res.ok) {
    await clearTokens();
    return null;
  }

  const data = await readJson(res, authTokensSchema);
  await storeTokens(data.access_token, data.refresh_token);
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
  let token = getAccessToken();
  if (!token && hasPersistedAuth()) {
    token = await refreshAccessToken();
  }
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
  if (!getAccessToken() && !hasPersistedAuth()) return;
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
  await storeTokens(data.access_token, data.refresh_token);

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
