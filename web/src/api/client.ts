import { z } from "zod";

import { brainOverviewSchema, type BrainOverview } from "./schemas";

export type { BrainOverview } from "./schemas";

const API_BASE = import.meta.env.VITE_API_BASE || "/api";

export async function readJson<T>(res: Response, schema: z.ZodType<T>): Promise<T> {
  return schema.parse(await res.json());
}

const authTokensSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
});

const brainIdListSchema = z.array(
  z.object({
    id: z.string(),
  }),
);

const brainOverviewListSchema = z.array(brainOverviewSchema);

function getAccessToken(): string | null {
  return localStorage.getItem("access_token");
}

function getRefreshToken(): string | null {
  return localStorage.getItem("refresh_token");
}

export function getBrainId(): string | null {
  return localStorage.getItem("brain_id");
}

function storeTokens(accessToken: string, refreshToken: string) {
  localStorage.setItem("access_token", accessToken);
  localStorage.setItem("refresh_token", refreshToken);
}

export function storeBrainId(brainId: string) {
  localStorage.setItem("brain_id", brainId);
  window.dispatchEvent(new StorageEvent("storage", { key: "brain_id" }));
}

export function clearTokens() {
  localStorage.removeItem("access_token");
  localStorage.removeItem("refresh_token");
  localStorage.removeItem("brain_id");
}

async function refreshAccessToken(): Promise<string | null> {
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

async function resolveDefaultBrain(token: string): Promise<string> {
  const res = await fetch(`${API_BASE}/brains`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error("Failed to fetch brains");

  const brains = await readJson(res, brainIdListSchema);
  if (!brains.length) throw new Error("No brains found");
  return brains[0].id;
}

export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const url = new URL(`${API_BASE}${path}`, location.origin);
  const brainId = getBrainId();
  if (brainId) url.searchParams.set("brain_id", brainId);

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

export async function ensureBrainId(): Promise<void> {
  if (getBrainId()) return;
  const token = getAccessToken();
  if (!token) return;
  const brainId = await resolveDefaultBrain(token);
  storeBrainId(brainId);
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
    const brainId = await resolveDefaultBrain(data.access_token);
    storeBrainId(brainId);
  } catch {
    throw new Error("Signed in, but failed to load your workspace. Please refresh.");
  }
}

export async function fetchBrains(): Promise<BrainOverview[]> {
  const res = await apiFetch("/brains");
  if (!res.ok) throw new Error("Failed to fetch brains");
  return readJson(res, brainOverviewListSchema);
}

export async function createBrain(name: string): Promise<BrainOverview> {
  const res = await apiFetch("/brains", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error("Failed to create project");
  return readJson(res, brainOverviewSchema);
}

export async function requestCode(email: string): Promise<void> {
  const res = await fetch(`${API_BASE}/auth/request-code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) throw new Error("Failed to send code");
}
