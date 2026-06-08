import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";

import { isDesktopRuntime } from "@/lib/runtime";

import {
  vaultPageSchema as vaultOverviewListSchema,
  vaultSchema as vaultOverviewSchema,
  type VaultOverview,
} from "./schemas";

export type { VaultOverview } from "./schemas";

const HOSTED_API_BASE = "https://great-minds-api.onrender.com/v1";
const AUTH_PERSISTED_KEY = "auth_persisted";
let accessTokenMemory: string | null = null;

let apiBaseInFlight: Promise<string> | null = null;

async function resolveApiBase(): Promise<string> {
  if (import.meta.env.VITE_API_BASE) return import.meta.env.VITE_API_BASE;
  if (!isDesktopRuntime()) return "/api";
  try {
    return (await invoke<string | null>("desktop_api_base")) ?? HOSTED_API_BASE;
  } catch (err) {
    console.warn("Failed to resolve desktop API base", err);
    return HOSTED_API_BASE;
  }
}

export function getApiBase(): Promise<string> {
  if (!apiBaseInFlight) apiBaseInFlight = resolveApiBase();
  return apiBaseInFlight;
}

export async function isLocalApiBase(): Promise<boolean> {
  const apiBase = await getApiBase();
  try {
    const { hostname } = new URL(apiBase, location.origin);
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  } catch {
    return false;
  }
}

export async function readJson<T>(res: Response, schema: z.ZodType<T>): Promise<T> {
  return schema.parse(await res.json());
}

const authTokensSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
});

function getAccessToken(): string | null {
  return isDesktopRuntime() ? accessTokenMemory : localStorage.getItem("access_token");
}

async function getRefreshToken(): Promise<string | null> {
  if (!isDesktopRuntime()) return localStorage.getItem("refresh_token");
  try {
    return await invoke<string | null>("get_refresh_token");
  } catch (err) {
    console.warn("Failed to read refresh token from secure storage", err);
    return null;
  }
}

export function hasPersistedAuth(): boolean {
  if (!isDesktopRuntime()) return Boolean(localStorage.getItem("refresh_token"));
  return localStorage.getItem(AUTH_PERSISTED_KEY) === "true";
}

export function getCurrentAccessToken(): string | null {
  return getAccessToken();
}

export function getVaultId(): string | null {
  return localStorage.getItem("vault_id");
}

async function storeTokens(accessToken: string, refreshToken: string): Promise<void> {
  if (isDesktopRuntime()) {
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
  if (isDesktopRuntime()) {
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

  const apiBase = await getApiBase();
  const res = await fetch(`${apiBase}/auth/refresh`, {
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

async function resolveDefaultVault(): Promise<string | null> {
  const res = await apiFetch("/vaults");
  if (!res.ok) throw new Error("Failed to fetch vaults");

  const vaults = await readJson(res, vaultOverviewListSchema);
  return vaults.items[0]?.id ?? null;
}

export function vaultPath(path: string): string {
  const vaultId = getVaultId();
  if (!vaultId) throw new Error("No vault selected");
  return `/vaults/${vaultId}${path}`;
}

export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const apiBase = await getApiBase();
  const url = new URL(`${apiBase}${path}`, location.origin);

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
  if (vaultId) storeVaultId(vaultId);
}

let localBootstrapInFlight: Promise<void> | null = null;

async function doBootstrapLocalAuth(): Promise<void> {
  if (!isDesktopRuntime() || !(await isLocalApiBase())) return;
  const apiBase = await getApiBase();
  const res = await fetch(`${apiBase}/local/bootstrap`, { method: "POST" });
  if (!res.ok) throw new Error("Local bootstrap failed");

  const data = await readJson(res, authTokensSchema);
  await storeTokens(data.access_token, data.refresh_token);

  const vaultId = await resolveDefaultVault();
  if (vaultId) storeVaultId(vaultId);
}

export function bootstrapLocalAuth(): Promise<void> {
  if (!localBootstrapInFlight) {
    localBootstrapInFlight = doBootstrapLocalAuth().finally(() => {
      localBootstrapInFlight = null;
    });
  }
  return localBootstrapInFlight;
}

export async function loginWithCode(email: string, code: string): Promise<void> {
  const apiBase = await getApiBase();
  const res = await fetch(`${apiBase}/auth/verify-code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, code }),
  });
  if (!res.ok) throw new Error("Invalid or expired code");

  const data = await readJson(res, authTokensSchema);
  await storeTokens(data.access_token, data.refresh_token);

  try {
    const vaultId = await resolveDefaultVault();
    if (vaultId) storeVaultId(vaultId);
  } catch {
    throw new Error("Signed in, but failed to load your projects. Please refresh.");
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
  const apiBase = await getApiBase();
  const res = await fetch(`${apiBase}/auth/request-code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) throw new Error("Failed to send code");
}
