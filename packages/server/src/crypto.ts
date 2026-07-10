import { createHash, randomBytes, randomInt } from "node:crypto";

import { Effect } from "effect";

export const sha256Hex = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export const contentHash = (...parts: readonly string[]) => {
  const hash = createHash("sha256");
  for (const part of parts) {
    const bytes = Buffer.from(part);
    const length = Buffer.alloc(4);
    length.writeUInt32LE(bytes.length, 0);
    hash.update(length);
    hash.update(bytes);
  }
  return hash.digest("hex");
};

export const fileContentHash = (content: string) => contentHash("file", content);

export const bodyContentHash = (body: string) => contentHash("body", body);

export const generateAuthCode = Effect.sync(() =>
  randomInt(0, 1_000_000).toString().padStart(6, "0")
);

export const generateRefreshToken = Effect.sync(() => randomBytes(48).toString("base64url"));

export const generateApiKey = Effect.sync(() => `gm_${randomBytes(32).toString("base64url")}`);
