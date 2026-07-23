import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/browser";
import { z } from "zod";

import { apiFetch, authTokensSchema, publicApiFetch, readJson, type AuthTokens } from "./client";
import { passkeySchema, type Passkey } from "./schemas";

const transportSchema = z.enum(["ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb"]);

const credentialDescriptorSchema = z.object({
  id: z.string(),
  type: z.literal("public-key"),
  transports: z.array(transportSchema).optional(),
});

const registrationOptionsSchema = z.object({
  rp: z.object({
    id: z.string().optional(),
    name: z.string(),
  }),
  user: z.object({
    id: z.string(),
    name: z.string(),
    displayName: z.string(),
  }),
  challenge: z.string(),
  pubKeyCredParams: z.array(
    z.object({
      alg: z.number(),
      type: z.literal("public-key"),
    }),
  ),
  timeout: z.number().optional(),
  excludeCredentials: z.array(credentialDescriptorSchema).optional(),
  authenticatorSelection: z
    .object({
      authenticatorAttachment: z.enum(["cross-platform", "platform"]).optional(),
      residentKey: z.enum(["discouraged", "preferred", "required"]).optional(),
      requireResidentKey: z.boolean().optional(),
      userVerification: z.enum(["discouraged", "preferred", "required"]).optional(),
    })
    .optional(),
  hints: z.array(z.enum(["hybrid", "security-key", "client-device"])).optional(),
  attestation: z.enum(["direct", "enterprise", "none"]).optional(),
  attestationFormats: z
    .array(
      z.enum(["fido-u2f", "packed", "android-safetynet", "android-key", "tpm", "apple", "none"]),
    )
    .optional(),
});

const authenticationOptionsSchema = z.object({
  challenge: z.string(),
  timeout: z.number().optional(),
  rpId: z.string().optional(),
  allowCredentials: z.array(credentialDescriptorSchema).optional(),
  userVerification: z.enum(["discouraged", "preferred", "required"]).optional(),
  hints: z.array(z.enum(["hybrid", "security-key", "client-device"])).optional(),
});

export type { Passkey };

export async function getPasskeyRegistrationOptions(): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const res = await apiFetch("/auth/passkeys/register-options", { method: "POST" });
  if (!res.ok) throw new Error("Failed to start passkey registration");
  return readJson(res, registrationOptionsSchema);
}

export async function registerPasskey(
  name: string,
  response: RegistrationResponseJSON,
): Promise<Passkey> {
  const res = await apiFetch("/auth/passkeys/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...response, name }),
  });
  if (!res.ok) {
    const detail = await res
      .json()
      .then((body: unknown) =>
        typeof body === "object" && body !== null && "detail" in body
          ? String((body as { detail: unknown }).detail)
          : null,
      )
      .catch(() => null);
    throw new Error(detail ?? `Failed to register passkey (${res.status})`);
  }
  return readJson(res, passkeySchema);
}

export async function getPasskeyAuthenticationOptions(): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const res = await publicApiFetch("/auth/passkeys/options", { method: "POST" });
  if (!res.ok) throw new Error("Failed to start passkey sign-in");
  return readJson(res, authenticationOptionsSchema);
}

export async function verifyPasskey(response: AuthenticationResponseJSON): Promise<AuthTokens> {
  const res = await publicApiFetch("/auth/passkeys/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(response),
  });
  if (!res.ok) throw new Error("Passkey sign-in failed");
  return readJson(res, authTokensSchema);
}

export async function listPasskeys(): Promise<Passkey[]> {
  const res = await apiFetch("/auth/passkeys");
  if (!res.ok) throw new Error("Failed to list passkeys");
  return readJson(res, z.array(passkeySchema));
}

export async function deletePasskey(id: string): Promise<void> {
  const res = await apiFetch(`/auth/passkeys/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to delete passkey");
}
