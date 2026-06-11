import { createHash, randomBytes, randomInt } from "node:crypto";
import { Context, Data, Effect, Layer } from "effect";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { jwtVerify, SignJWT } from "jose";
import { Db, type BackendDb, type DbSession } from "@great-minds/db/context";
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
import { firstOrDie, firstOrFail } from "./effect-helpers.js";
import { ensureUser } from "./users.js";

export type AuthConfigService = {
  jwtSecret: string;
  jwtAccessExpiryMinutes: number;
  jwtRefreshExpiryDays: number;
  authCodeExpiryMinutes: number;
  suppressAuth?: boolean;
};

export class AuthConfig extends Context.Service<
  AuthConfig,
  AuthConfigService
>()("AuthConfig") {}

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

export type AuthCodeDeliveryService = {
  readonly deliver: (email: string, code: string, expiresInMinutes: number) => Effect.Effect<void, AuthCodeDeliveryFailed>;
};

export class AuthCodeDelivery extends Context.Service<
  AuthCodeDelivery,
  AuthCodeDeliveryService
>()("AuthCodeDelivery") {}

export class InvalidAuthCode extends Data.TaggedError("InvalidAuthCode")<{
  message: string;
}> {}

export class InvalidRefreshToken extends Data.TaggedError("InvalidRefreshToken")<{
  message: string;
}> {}

export class ApiKeyUnavailable extends Data.TaggedError("ApiKeyUnavailable")<{
  message: string;
}> {}

export class AuthService extends Context.Service<
  AuthService,
  {
    readonly requestCode: (input: UserCreate) => Effect.Effect<void, AuthCodeDeliveryFailed>;
    readonly verifyCode: (input: UserCreate, code: string) => Effect.Effect<TokenPair, InvalidAuthCode>;
    readonly refreshTokens: (refreshToken: string) => Effect.Effect<TokenPair, InvalidRefreshToken>;
    readonly resolveBearerToken: (token: string) => Effect.Effect<AuthenticatedPrincipal | null>;
    readonly createApiKey: (userId: UserId, input: ApiKeyCreate) => Effect.Effect<ApiKeyWithSecret>;
    readonly listApiKeys: (userId: UserId) => Effect.Effect<ApiKey[]>;
    readonly revokeApiKey: (userId: UserId, keyId: ApiKeyId) => Effect.Effect<void, ApiKeyUnavailable>;
  }
>()("AuthService") {}

export const AuthServiceLive = Layer.effect(
  AuthService,
  Effect.gen(function* () {
    const db = yield* Db;
    const config = yield* AuthConfig;
    const delivery = yield* AuthCodeDelivery;

    return AuthService.of({
      requestCode: (input) =>
        requestAuthCode(input).pipe(
          Effect.provideService(Db, db),
          Effect.provideService(AuthConfig, config),
          Effect.provideService(AuthCodeDelivery, delivery),
        ),
      verifyCode: (input, code) =>
        verifyCode(input, code).pipe(
          Effect.provideService(Db, db),
          Effect.provideService(AuthConfig, config),
        ),
      refreshTokens: (refreshToken) =>
        refreshAuthTokens(refreshToken).pipe(
          Effect.provideService(Db, db),
          Effect.provideService(AuthConfig, config),
        ),
      resolveBearerToken: (token) =>
        resolveBearerToken(token).pipe(
          Effect.provideService(Db, db),
          Effect.provideService(AuthConfig, config),
        ),
      createApiKey: (userId, input) => createApiKey(userId, input).pipe(Effect.provideService(Db, db)),
      listApiKeys: (userId) => listApiKeys(userId).pipe(Effect.provideService(Db, db)),
      revokeApiKey: (userId, keyId) => revokeApiKey(userId, keyId).pipe(Effect.provideService(Db, db)),
    });
  }),
);

export function requestAuthCode(
  input: UserCreate,
): Effect.Effect<void, AuthCodeDeliveryFailed, Db | AuthCodeDelivery | AuthConfig> {
  return Effect.gen(function* () {
    const config = yield* AuthConfig;
    if (config.suppressAuth) return;

    const db = yield* Db;
    const code = generateAuthCode();
    yield* db
      .update(authCodes)
      .set({ used: true })
      .where(and(eq(authCodes.email, input.email), eq(authCodes.used, false)))
      .pipe(Effect.orDie);

    yield* db
      .insert(authCodes)
      .values({
        email: input.email,
        codeHash: hashSecret(code),
        expiresAt: sql`now() + ${config.authCodeExpiryMinutes} * interval '1 minute'`,
      })
      .pipe(Effect.orDie);

    const delivery = yield* AuthCodeDelivery;
    yield* delivery.deliver(input.email, code, config.authCodeExpiryMinutes);
  });
}

export function verifyCode(
  input: UserCreate,
  code: string,
): Effect.Effect<TokenPair, InvalidAuthCode, Db | AuthConfig> {
  return Effect.gen(function* () {
    const config = yield* AuthConfig;
    const db = yield* Db;
    if (!config.suppressAuth) {
      const valid = yield* consumeAuthCode(db, input.email, code);
      if (!valid) return yield* Effect.fail(new InvalidAuthCode({ message: "Invalid or expired code" }));
    }

    const user = yield* ensureUser(input);
    return yield* mintTokenPair(db, user.id, config);
  });
}

export function refreshAuthTokens(
  refreshToken: string,
): Effect.Effect<TokenPair, InvalidRefreshToken, Db | AuthConfig> {
  return Effect.gen(function* () {
    const config = yield* AuthConfig;
    const db = yield* Db;
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
      .pipe(Effect.orDie);

    const stored = yield* firstOrFail(rows, () => new InvalidRefreshToken({ message: "Invalid or expired refresh token" }));

    return yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          yield* tx
            .update(refreshTokens)
            .set({ revoked: true })
            .where(eq(refreshTokens.id, stored.id))
            .pipe(Effect.orDie);
          return yield* mintTokenPair(tx, UserIdSchema.parse(stored.userId), config);
        }),
      )
      .pipe(Effect.orDie);
  });
}

export function resolveBearerToken(
  token: string,
): Effect.Effect<AuthenticatedPrincipal | null, never, Db | AuthConfig> {
  return Effect.gen(function* () {
    const config = yield* AuthConfig;
    const db = yield* Db;
    const userFromAccessToken = yield* resolveAccessToken(db, token, config);
    if (userFromAccessToken) return userFromAccessToken;

    return yield* resolveApiKey(db, token);
  });
}

export function createApiKey(
  userId: UserId,
  input: ApiKeyCreate,
): Effect.Effect<ApiKeyWithSecret, never, Db> {
  return Effect.gen(function* () {
    const db = yield* Db;
    const rawKey = `gm_${randomBytes(32).toString("base64url")}`;
    const rows = yield* db
      .insert(apiKeys)
      .values({ userId, keyHash: hashSecret(rawKey), label: input.label, scopes: input.scopes })
      .returning()
      .pipe(Effect.orDie);

    const apiKey = yield* firstOrDie(rows, "Failed to create API key");
    return ApiKeyWithSecretSchema.parse({ ...apiKey, rawKey });
  });
}

export function listApiKeys(userId: UserId): Effect.Effect<ApiKey[], never, Db> {
  return Effect.gen(function* () {
    const db = yield* Db;
    const rows = yield* db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.userId, userId))
      .orderBy(desc(apiKeys.createdAt))
      .pipe(Effect.orDie);

    return ApiKeySchema.array().parse(rows);
  });
}

export function revokeApiKey(
  userId: UserId,
  keyId: ApiKeyId,
): Effect.Effect<void, ApiKeyUnavailable, Db> {
  return Effect.gen(function* () {
    const db = yield* Db;
    const rows = yield* db
      .update(apiKeys)
      .set({ revoked: true })
      .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, userId)))
      .returning({ id: apiKeys.id })
      .pipe(Effect.orDie);

    yield* firstOrFail(rows, () => new ApiKeyUnavailable({ message: "API key not found" }));
  });
}

function consumeAuthCode(db: BackendDb, email: string, code: string): Effect.Effect<boolean> {
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
      .pipe(Effect.orDie);

    const authCode = rows[0];
    if (!authCode) return false;
    yield* db
      .update(authCodes)
      .set({ used: true })
      .where(eq(authCodes.id, authCode.id))
      .pipe(Effect.orDie);
    return true;
  });
}

function mintTokenPair(db: DbSession, userId: UserId, config: AuthConfigService): Effect.Effect<TokenPair> {
  return Effect.gen(function* () {
    const accessToken = yield* Effect.promise(() => createAccessToken(userId, config));
    const refreshToken = createRefreshTokenValue();

    yield* db
      .insert(refreshTokens)
      .values({
        userId,
        tokenHash: hashSecret(refreshToken),
        expiresAt: sql`now() + ${config.jwtRefreshExpiryDays} * interval '1 day'`,
      })
      .pipe(Effect.orDie);

    return { accessToken, refreshToken };
  });
}

function resolveAccessToken(
  db: BackendDb,
  token: string,
  config: AuthConfigService,
): Effect.Effect<AuthenticatedPrincipal | null> {
  return Effect.gen(function* () {
    const userId = yield* Effect.promise(() => decodeAccessToken(token, config));
    if (!userId) return null;

    const rows = yield* db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
      .pipe(Effect.orDie);
    const user = rows[0];
    if (!user) return null;
    return { user: UserSchema.parse(user), credential: { kind: "session" as const } };
  });
}

function resolveApiKey(db: BackendDb, rawKey: string): Effect.Effect<AuthenticatedPrincipal | null> {
  return Effect.gen(function* () {
    const rows = yield* db
      .select({ apiKeyId: apiKeys.id, scopes: apiKeys.scopes, user: users })
      .from(apiKeys)
      .innerJoin(users, eq(users.id, apiKeys.userId))
      .where(and(eq(apiKeys.keyHash, hashSecret(rawKey)), eq(apiKeys.revoked, false)))
      .limit(1)
      .pipe(Effect.orDie);

    const row = rows[0];
    if (!row) return null;
    return {
      user: UserSchema.parse(row.user),
      credential: {
        kind: "apiKey" as const,
        apiKeyId: ApiKeyIdSchema.parse(row.apiKeyId),
        scopes: ApiKeyScopeSchema.array().parse(row.scopes),
      },
    };
  });
}

async function createAccessToken(userId: UserId, config: AuthConfigService): Promise<string> {
  const secret = new TextEncoder().encode(config.jwtSecret);
  return new SignJWT({ type: "access" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${config.jwtAccessExpiryMinutes}m`)
    .sign(secret);
}

async function decodeAccessToken(token: string, config: AuthConfigService): Promise<UserId | null> {
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

