import { createHmac, randomBytes } from "node:crypto";

import type { AuthenticatedUser, TokenPair } from "@great-minds/domain";

import { readEnv } from "./env.ts";

type JwtPayload = {
  sub: string;
  email: string;
  exp: number;
  typ: "access" | "refresh";
};

const base64Url = (input: Buffer | string) =>
  Buffer.from(input).toString("base64url");

const decodeBase64Url = (input: string) =>
  Buffer.from(input, "base64url").toString("utf8");

const jwtSecret = () => readEnv("JWT_SECRET") ?? "spike-zero-local-secret";

const sign = (payload: JwtPayload) => {
  const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64Url(JSON.stringify(payload));
  const signature = createHmac("sha256", jwtSecret())
    .update(`${header}.${body}`)
    .digest("base64url");
  return `${header}.${body}.${signature}`;
};

export const issueTokens = (user: AuthenticatedUser): TokenPair => {
  const now = Math.floor(Date.now() / 1000);
  return {
    accessToken: sign({
      sub: user.id,
      email: user.email,
      exp: now + 15 * 60,
      typ: "access"
    }),
    refreshToken: sign({
      sub: user.id,
      email: user.email,
      exp: now + 7 * 24 * 60 * 60,
      typ: "refresh"
    }),
    tokenType: "bearer"
  };
};

export const verifyAccessToken = (token: string): AuthenticatedUser => {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid JWT");
  }
  const [header, body, signature] = parts;
  const expected = createHmac("sha256", jwtSecret())
    .update(`${header}.${body}`)
    .digest("base64url");
  if (signature !== expected) {
    throw new Error("Invalid JWT signature");
  }
  const payload = JSON.parse(decodeBase64Url(body)) as JwtPayload;
  if (payload.typ !== "access" || payload.exp <= Math.floor(Date.now() / 1000)) {
    throw new Error("Expired or non-access JWT");
  }
  return {
    id: payload.sub as AuthenticatedUser["id"],
    email: payload.email as AuthenticatedUser["email"]
  };
};

export const stableSpikeUser = (email: string): AuthenticatedUser => {
  const seed = createHmac("sha256", "spike-user").update(email).digest("hex");
  const id = [
    seed.slice(0, 8),
    seed.slice(8, 12),
    `4${seed.slice(13, 16)}`,
    `8${seed.slice(17, 20)}`,
    seed.slice(20, 32)
  ].join("-");
  return {
    id: id as AuthenticatedUser["id"],
    email: email as AuthenticatedUser["email"]
  };
};

export const randomCode = () => randomBytes(3).toString("hex");
