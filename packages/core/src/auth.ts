import { createHash, randomBytes, randomInt } from "node:crypto";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { jwtVerify, SignJWT } from "jose";
import type { BackendDb, DbSession } from "@great-minds/db/context";
import { apiKeys, authCodes, refreshTokens, users } from "@great-minds/db/schema";
import {
  ApiKeyIdSchema,
  ApiKeyScopeSchema,
  ApiKeySchema,
  ApiKeyWithSecretSchema,
  type ApiKey,
  type ApiKeyCreate,
  type ApiKeyId,
  type ApiKeyScope,
  type ApiKeyWithSecret,
} from "@great-minds/domain/auth";
import {
  UserIdSchema,
  UserSchema,
  type User,
  type UserCreate,
  type UserId,
} from "@great-minds/domain/user";
import { ensureUser } from "./users.js";

export type AuthConfig = {
  jwtSecret: string;
  jwtAccessExpiryMinutes: number;
  jwtRefreshExpiryDays: number;
  authCodeExpiryMinutes: number;
  suppressAuth?: boolean;
};

export type AuthenticatedPrincipal =
  | {
      user: User;
      credential: { kind: "session" };
    }
  | {
      user: User;
      credential: { kind: "apiKey"; apiKeyId: ApiKeyId; scopes: ApiKeyScope[] };
    };

export async function requestAuthCode(
  db: BackendDb,
  input: UserCreate,
  config: AuthConfig,
  deliverCode: (email: string, code: string) => Promise<void> | void,
): Promise<void> {
  if (config.suppressAuth) return;

  const code = generateAuthCode();
  await db
    .update(authCodes)
    .set({ used: true })
    .where(and(eq(authCodes.email, input.email), eq(authCodes.used, false)));

  await db.insert(authCodes).values({
    email: input.email,
    codeHash: hashSecret(code),
    expiresAt: sql`now() + ${config.authCodeExpiryMinutes} * interval '1 minute'`,
  });

  await deliverCode(input.email, code);
}

export async function verifyCode(
  db: BackendDb,
  input: UserCreate,
  code: string,
  config: AuthConfig,
) {
  if (!config.suppressAuth) {
    const valid = await consumeAuthCode(db, input.email, code);
    if (!valid) throw new Error("Invalid or expired code");
  }

  const user = await ensureUser(db, input);
  return mintTokenPair(db, user.id, config);
}

export async function refreshAuthTokens(
  db: BackendDb,
  refreshToken: string,
  config: AuthConfig,
) {
  const tokenHash = hashSecret(refreshToken);
  const [stored] = await db
    .select()
    .from(refreshTokens)
    .where(
      and(
        eq(refreshTokens.tokenHash, tokenHash),
        eq(refreshTokens.revoked, false),
        gt(refreshTokens.expiresAt, sql`now()`),
      ),
    )
    .limit(1);

  if (!stored) throw new Error("Invalid or expired refresh token");

  return db.transaction(async (tx) => {
    await tx.update(refreshTokens).set({ revoked: true }).where(eq(refreshTokens.id, stored.id));
    return mintTokenPair(tx, UserIdSchema.parse(stored.userId), config);
  });
}

export async function resolveBearerToken(
  db: BackendDb,
  token: string,
  config: AuthConfig,
): Promise<AuthenticatedPrincipal | null> {
  const userFromAccessToken = await resolveAccessToken(db, token, config);
  if (userFromAccessToken) return userFromAccessToken;

  return resolveApiKey(db, token);
}

export async function createApiKey(
  db: BackendDb,
  userId: UserId,
  input: ApiKeyCreate,
): Promise<ApiKeyWithSecret> {
  const rawKey = `gm_${randomBytes(32).toString("base64url")}`;
  const [apiKey] = await db
    .insert(apiKeys)
    .values({ userId, keyHash: hashSecret(rawKey), label: input.label, scopes: input.scopes })
    .returning();

  if (!apiKey) throw new Error("Failed to create API key");
  return ApiKeyWithSecretSchema.parse({ ...apiKey, rawKey });
}

export async function listApiKeys(db: BackendDb, userId: UserId): Promise<ApiKey[]> {
  const rows = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.userId, userId))
    .orderBy(desc(apiKeys.createdAt));

  return ApiKeySchema.array().parse(rows);
}

export async function revokeApiKey(
  db: BackendDb,
  userId: UserId,
  keyId: ApiKeyId,
): Promise<void> {
  const [apiKey] = await db
    .update(apiKeys)
    .set({ revoked: true })
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, userId)))
    .returning({ id: apiKeys.id });

  if (!apiKey) throw new Error("API key not found");
}

async function consumeAuthCode(db: BackendDb, email: string, code: string): Promise<boolean> {
  const [authCode] = await db
    .select({ id: authCodes.id })
    .from(authCodes)
    .where(
      and(
        eq(authCodes.email, email),
        eq(authCodes.codeHash, hashSecret(code)),
        eq(authCodes.used, false),
        gt(authCodes.expiresAt, sql`now()`),
      ),
    )
    .limit(1);

  if (!authCode) return false;
  await db.update(authCodes).set({ used: true }).where(eq(authCodes.id, authCode.id));
  return true;
}

async function mintTokenPair(db: DbSession, userId: UserId, config: AuthConfig) {
  const accessToken = await createAccessToken(userId, config);
  const refreshToken = createRefreshTokenValue();

  await db.insert(refreshTokens).values({
    userId,
    tokenHash: hashSecret(refreshToken),
    expiresAt: sql`now() + ${config.jwtRefreshExpiryDays} * interval '1 day'`,
  });

  return { accessToken, refreshToken };
}

async function resolveAccessToken(
  db: BackendDb,
  token: string,
  config: AuthConfig,
): Promise<AuthenticatedPrincipal | null> {
  const userId = await decodeAccessToken(token, config);
  if (!userId) return null;

  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) return null;
  return { user: UserSchema.parse(user), credential: { kind: "session" } };
}

async function resolveApiKey(db: BackendDb, rawKey: string): Promise<AuthenticatedPrincipal | null> {
  const [row] = await db
    .select({ apiKeyId: apiKeys.id, scopes: apiKeys.scopes, user: users })
    .from(apiKeys)
    .innerJoin(users, eq(users.id, apiKeys.userId))
    .where(and(eq(apiKeys.keyHash, hashSecret(rawKey)), eq(apiKeys.revoked, false)))
    .limit(1);

  if (!row) return null;
  return {
    user: UserSchema.parse(row.user),
    credential: {
      kind: "apiKey",
      apiKeyId: ApiKeyIdSchema.parse(row.apiKeyId),
      scopes: ApiKeyScopeSchema.array().parse(row.scopes),
    },
  };
}

async function createAccessToken(userId: UserId, config: AuthConfig): Promise<string> {
  const secret = new TextEncoder().encode(config.jwtSecret);
  return new SignJWT({ type: "access" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${config.jwtAccessExpiryMinutes}m`)
    .sign(secret);
}

async function decodeAccessToken(token: string, config: AuthConfig): Promise<UserId | null> {
  try {
    const secret = new TextEncoder().encode(config.jwtSecret);
    const { payload } = await jwtVerify(token, secret, {
      algorithms: ["HS256"],
      requiredClaims: ["sub", "type"],
    });
    if (payload.type !== "access") return null;

    const userId = UserIdSchema.safeParse(payload.sub);
    if (!userId.success) return null;
    return userId.data;
  } catch {
    return null;
  }
}

function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function generateAuthCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

function createRefreshTokenValue(): string {
  return randomBytes(48).toString("base64url");
}

