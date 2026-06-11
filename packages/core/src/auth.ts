import { createHash, randomBytes, randomInt } from "node:crypto";
import { Data, Effect } from "effect";
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
import { firstOrFail, parseOrFail } from "./effect-helpers.js";
import { ensureUser, type UserPersistenceFailed } from "./users.js";

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

export type TokenPair = {
  accessToken: string;
  refreshToken: string;
};

export class AuthCodeDeliveryFailed extends Data.TaggedError("AuthCodeDeliveryFailed")<{
  message: string;
}> {}

export class InvalidAuthCode extends Data.TaggedError("InvalidAuthCode")<{
  message: string;
}> {}

export class InvalidRefreshToken extends Data.TaggedError("InvalidRefreshToken")<{
  message: string;
}> {}

export class AuthPersistenceFailed extends Data.TaggedError("AuthPersistenceFailed")<{
  message: string;
}> {}

export class ApiKeyUnavailable extends Data.TaggedError("ApiKeyUnavailable")<{
  message: string;
}> {}

export function requestAuthCode(
  db: BackendDb,
  input: UserCreate,
  config: AuthConfig,
  deliverCode: (email: string, code: string) => Promise<void> | void,
): Effect.Effect<void, AuthCodeDeliveryFailed | AuthPersistenceFailed> {
  if (config.suppressAuth) return Effect.void;

  return Effect.gen(function* () {
    const code = generateAuthCode();
    yield* db
      .update(authCodes)
      .set({ used: true })
      .where(and(eq(authCodes.email, input.email), eq(authCodes.used, false)))
      .pipe(Effect.mapError(() => new AuthPersistenceFailed({ message: "Failed to store auth code" })));

    yield* db
      .insert(authCodes)
      .values({
        email: input.email,
        codeHash: hashSecret(code),
        expiresAt: sql`now() + ${config.authCodeExpiryMinutes} * interval '1 minute'`,
      })
      .pipe(Effect.mapError(() => new AuthPersistenceFailed({ message: "Failed to store auth code" })));

    yield* Effect.tryPromise({
      try: () => Promise.resolve(deliverCode(input.email, code)),
      catch: () => new AuthCodeDeliveryFailed({ message: "Failed to send auth code" }),
    });
  });
}

export function verifyCode(
  db: BackendDb,
  input: UserCreate,
  code: string,
  config: AuthConfig,
): Effect.Effect<TokenPair, AuthPersistenceFailed | InvalidAuthCode | UserPersistenceFailed> {
  return Effect.gen(function* () {
    if (!config.suppressAuth) {
      const valid = yield* consumeAuthCode(db, input.email, code);
      if (!valid) return yield* Effect.fail(new InvalidAuthCode({ message: "Invalid or expired code" }));
    }

    const user = yield* ensureUser(db, input);
    return yield* mintTokenPair(db, user.id, config);
  });
}

export function refreshAuthTokens(
  db: BackendDb,
  refreshToken: string,
  config: AuthConfig,
): Effect.Effect<TokenPair, AuthPersistenceFailed | InvalidRefreshToken> {
  return Effect.gen(function* () {
    const tokenHash = hashSecret(refreshToken);
    const rows = yield* db
      .select()
      .from(refreshTokens)
      .where(
        and(
          eq(refreshTokens.tokenHash, tokenHash),
          eq(refreshTokens.revoked, false),
          gt(refreshTokens.expiresAt, sql`now()`),
        ),
      )
      .limit(1)
      .pipe(Effect.mapError(() => new AuthPersistenceFailed({ message: "Failed to refresh auth tokens" })));

    const stored = yield* firstOrFail(rows, () => new InvalidRefreshToken({ message: "Invalid or expired refresh token" }));

    return yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          yield* tx
            .update(refreshTokens)
            .set({ revoked: true })
            .where(eq(refreshTokens.id, stored.id))
            .pipe(Effect.mapError(() => new AuthPersistenceFailed({ message: "Failed to refresh auth tokens" })));
          return yield* mintTokenPair(tx, UserIdSchema.parse(stored.userId), config);
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          error instanceof AuthPersistenceFailed
            ? error
            : new AuthPersistenceFailed({ message: "Failed to refresh auth tokens" }),
        ),
      );
  });
}

export function resolveBearerToken(
  db: BackendDb,
  token: string,
  config: AuthConfig,
): Effect.Effect<AuthenticatedPrincipal | null, AuthPersistenceFailed> {
  return Effect.gen(function* () {
    const userFromAccessToken = yield* resolveAccessToken(db, token, config);
    if (userFromAccessToken) return userFromAccessToken;

    return yield* resolveApiKey(db, token);
  });
}

export function createApiKey(
  db: BackendDb,
  userId: UserId,
  input: ApiKeyCreate,
): Effect.Effect<ApiKeyWithSecret, AuthPersistenceFailed> {
  return Effect.gen(function* () {
    const rawKey = `gm_${randomBytes(32).toString("base64url")}`;
    const rows = yield* db
      .insert(apiKeys)
      .values({ userId, keyHash: hashSecret(rawKey), label: input.label, scopes: input.scopes })
      .returning()
      .pipe(Effect.mapError(() => new AuthPersistenceFailed({ message: "Failed to create API key" })));

    const apiKey = yield* firstOrFail(rows, () => new AuthPersistenceFailed({ message: "Failed to create API key" }));
    return yield* parseOrFail(
      () => ApiKeyWithSecretSchema.parse({ ...apiKey, rawKey }),
      () => new AuthPersistenceFailed({ message: "Failed to create API key" }),
    );
  });
}

export function listApiKeys(db: BackendDb, userId: UserId): Effect.Effect<ApiKey[], AuthPersistenceFailed> {
  return Effect.gen(function* () {
    const rows = yield* db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.userId, userId))
      .orderBy(desc(apiKeys.createdAt))
      .pipe(Effect.mapError(() => new AuthPersistenceFailed({ message: "Failed to list API keys" })));

    return yield* parseOrFail(
      () => ApiKeySchema.array().parse(rows),
      () => new AuthPersistenceFailed({ message: "Failed to list API keys" }),
    );
  });
}

export function revokeApiKey(
  db: BackendDb,
  userId: UserId,
  keyId: ApiKeyId,
): Effect.Effect<void, ApiKeyUnavailable | AuthPersistenceFailed> {
  return Effect.gen(function* () {
    const rows = yield* db
      .update(apiKeys)
      .set({ revoked: true })
      .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, userId)))
      .returning({ id: apiKeys.id })
      .pipe(Effect.mapError(() => new AuthPersistenceFailed({ message: "Failed to revoke API key" })));

    yield* firstOrFail(rows, () => new ApiKeyUnavailable({ message: "API key not found" }));
  });
}

function consumeAuthCode(db: BackendDb, email: string, code: string): Effect.Effect<boolean, AuthPersistenceFailed> {
  return Effect.gen(function* () {
    const rows = yield* db
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
      .limit(1)
      .pipe(Effect.mapError(() => new AuthPersistenceFailed({ message: "Failed to consume auth code" })));

    const authCode = rows[0];
    if (!authCode) return false;
    yield* db
      .update(authCodes)
      .set({ used: true })
      .where(eq(authCodes.id, authCode.id))
      .pipe(Effect.mapError(() => new AuthPersistenceFailed({ message: "Failed to consume auth code" })));
    return true;
  });
}

function mintTokenPair(db: DbSession, userId: UserId, config: AuthConfig): Effect.Effect<TokenPair, AuthPersistenceFailed> {
  return Effect.gen(function* () {
    const accessToken = yield* Effect.tryPromise({
      try: () => createAccessToken(userId, config),
      catch: () => new AuthPersistenceFailed({ message: "Failed to mint auth tokens" }),
    });
    const refreshToken = createRefreshTokenValue();

    yield* db
      .insert(refreshTokens)
      .values({
        userId,
        tokenHash: hashSecret(refreshToken),
        expiresAt: sql`now() + ${config.jwtRefreshExpiryDays} * interval '1 day'`,
      })
      .pipe(Effect.mapError(() => new AuthPersistenceFailed({ message: "Failed to mint auth tokens" })));

    return { accessToken, refreshToken };
  });
}

function resolveAccessToken(
  db: BackendDb,
  token: string,
  config: AuthConfig,
): Effect.Effect<AuthenticatedPrincipal | null, AuthPersistenceFailed> {
  return Effect.gen(function* () {
    const userId = yield* Effect.promise(() => decodeAccessToken(token, config));
    if (!userId) return null;

    const rows = yield* db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
      .pipe(Effect.mapError(() => new AuthPersistenceFailed({ message: "Failed to resolve bearer token" })));
    const user = rows[0];
    if (!user) return null;
    return yield* parseOrFail(
      () => ({ user: UserSchema.parse(user), credential: { kind: "session" as const } }),
      () => new AuthPersistenceFailed({ message: "Failed to resolve bearer token" }),
    );
  });
}

function resolveApiKey(db: BackendDb, rawKey: string): Effect.Effect<AuthenticatedPrincipal | null, AuthPersistenceFailed> {
  return Effect.gen(function* () {
    const rows = yield* db
      .select({ apiKeyId: apiKeys.id, scopes: apiKeys.scopes, user: users })
      .from(apiKeys)
      .innerJoin(users, eq(users.id, apiKeys.userId))
      .where(and(eq(apiKeys.keyHash, hashSecret(rawKey)), eq(apiKeys.revoked, false)))
      .limit(1)
      .pipe(Effect.mapError(() => new AuthPersistenceFailed({ message: "Failed to resolve bearer token" })));

    const row = rows[0];
    if (!row) return null;
    return yield* parseOrFail(
      () => ({
        user: UserSchema.parse(row.user),
        credential: {
          kind: "apiKey" as const,
          apiKeyId: ApiKeyIdSchema.parse(row.apiKeyId),
          scopes: ApiKeyScopeSchema.array().parse(row.scopes),
        },
      }),
      () => new AuthPersistenceFailed({ message: "Failed to resolve bearer token" }),
    );
  });
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

