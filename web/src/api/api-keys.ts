import { z } from "zod";

import { apiFetch, readJson } from "./client";
import { apiKeyCreatedSchema, apiKeySchema, type ApiKey, type ApiKeyCreated } from "./schemas";

export type { ApiKey, ApiKeyCreated };

export async function listApiKeys(): Promise<ApiKey[]> {
  const res = await apiFetch("/auth/api-keys");
  if (!res.ok) throw new Error("Failed to list API keys");
  return readJson(res, z.array(apiKeySchema));
}

export async function createApiKey(label: string): Promise<ApiKeyCreated> {
  const res = await apiFetch("/auth/api-keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label }),
  });
  if (!res.ok) throw new Error("Failed to create API key");
  return readJson(res, apiKeyCreatedSchema);
}

export async function revokeApiKey(keyId: string): Promise<void> {
  const res = await apiFetch(`/auth/api-keys/${keyId}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to revoke API key");
}
