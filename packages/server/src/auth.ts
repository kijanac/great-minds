import { randomUUID } from "node:crypto";

import {
  apiKeys,
  authCodes,
  Database,
  refreshTokens,
  type TransactionClient,
  users,
} from "@great-minds/database";
import {
  Email,
  NotFound,
  ServiceUnavailable,
  TooManyRequests,
  Unauthorized,
  Uuid,
} from "@great-minds/domain";
import type { ApiKey, ApiKeyWithSecret, AuthContext, TokenPair } from "@great-minds/domain";
import { and, asc, desc, eq, gt, isNull, lt, sql, type SQL } from "drizzle-orm";
import { Context, Effect, Layer, Option, Result, Schema } from "effect";

import { backgroundLoop } from "./background-loop.ts";
import { ClockService } from "./clock.ts";
import { AppConfig } from "./config.ts";
import { generateApiKey, generateAuthCode, generateRefreshToken, sha256Hex } from "./crypto.ts";
import { Mailer } from "./mailer.ts";
import { TokenService } from "./tokens.ts";
import { VaultsService } from "./vaults.ts";

type UserRow = typeof users.$inferSelect;
type ApiKeyRow = typeof apiKeys.$inferSelect;

type AuthServiceShape = {
  readonly requestCode: (
    email: Email,
    clientAddress: string | null,
  ) => Effect.Effect<void, ServiceUnavailable | TooManyRequests>;
  readonly verifyCode: (email: Email, code: string) => Effect.Effect<TokenPair, Unauthorized>;
  readonly refresh: (refreshToken: string) => Effect.Effect<TokenPair, Unauthorized>;
  readonly issueTokenPair: (userId: Uuid) => Effect.Effect<TokenPair, Unauthorized>;
  readonly authenticateBearer: (token: string) => Effect.Effect<AuthContext, Unauthorized>;
  readonly createApiKey: (
    userId: Uuid,
    label: string,
    grant?: KeyGrant,
  ) => Effect.Effect<ApiKeyWithSecret>;
  readonly ensureUser: (email: Email) => Effect.Effect<Uuid, Unauthorized>;
  readonly findUser: (email: Email) => Effect.Effect<Option.Option<Uuid>>;
  readonly listApiKeys: (userId: Uuid) => Effect.Effect<readonly ApiKey[]>;
  readonly revokeApiKey: (userId: Uuid, keyId: Uuid) => Effect.Effect<void, NotFound>;
  readonly purgeSignInCodesOnce: () => Effect.Effect<number>;
};

export class AuthService extends Context.Service<AuthService, AuthServiceShape>()(
  "@great-minds/server/AuthService",
) {}

const normalizeEmail = (email: Email): Email =>
  Schema.decodeUnknownSync(Email)(email.trim().toLowerCase());

const asEmail = (value: string): Email => value as Email;

const addMinutes = (date: Date, minutes: number) => new Date(date.getTime() + minutes * 60 * 1000);

const addDays = (date: Date, days: number) => new Date(date.getTime() + days * 24 * 60 * 60 * 1000);

const tokenPair = (accessToken: string, refreshToken: string): TokenPair => ({
  access_token: accessToken,
  refresh_token: refreshToken,
  token_type: "bearer",
});

const apiKeyResponse = (row: ApiKeyRow): ApiKey => ({
  id: row.id,
  label: row.label,
  created_at: row.createdAt,
  revoked: row.revoked,
  vault_ids: row.vaultIds,
  can_ask: row.canAsk,
  can_change: row.canChange,
  expires_at: row.expiresAt,
  last_used_at: row.lastUsedAt,
});

export type KeyGrant = {
  readonly vaultIds?: readonly Uuid[] | null;
  readonly canAsk?: boolean;
  readonly canChange?: boolean;
  readonly expiresAt?: Date | null;
};

const LAST_USED_RESOLUTION_MS = 60 * 1000;

const firstUser = (rows: readonly UserRow[]) => {
  const row = rows[0];
  if (row === undefined) {
    throw new Error("expected user row");
  }
  return row;
};

const hours = (count: number) => count * 60 * 60 * 1000;

export const signInCodePolicy = {
  wrongGuessesPerCode: 5,
  resendIntervalMs: 60 * 1000,
  sendsPerEmail: { limit: 10, windowMs: hours(24) },
  sendsPerClient: { limit: 30, windowMs: hours(1) },
} as const;

const retentionMs = Math.max(
  signInCodePolicy.sendsPerEmail.windowMs,
  signInCodePolicy.sendsPerClient.windowMs,
);

const plural = (count: number, unit: string) => `${count} ${unit}${count === 1 ? "" : "s"}`;

const waitText = (seconds: number) => {
  if (seconds < 60) return plural(seconds, "second");
  if (seconds < 60 * 60) return plural(Math.ceil(seconds / 60), "minute");
  return plural(Math.ceil(seconds / (60 * 60)), "hour");
};

type SendRefusal = {
  readonly until: number;
  readonly detail: (wait: string) => string;
};

const windowRefusal = (
  sends: readonly Date[],
  limit: { readonly limit: number; readonly windowMs: number },
  detail: (wait: string) => string,
): SendRefusal | undefined => {
  const oldestCounted = sends[sends.length - limit.limit];
  return oldestCounted === undefined
    ? undefined
    : { until: oldestCounted.getTime() + limit.windowMs, detail };
};

const sendRefusal = (
  now: Date,
  emailSends: readonly Date[],
  clientSends: readonly Date[],
): TooManyRequests | undefined => {
  const latest = emailSends.at(-1);
  const refusals = [
    latest !== undefined && latest.getTime() + signInCodePolicy.resendIntervalMs > now.getTime()
      ? {
          until: latest.getTime() + signInCodePolicy.resendIntervalMs,
          detail: (wait: string) => `A code was just sent. You can request another in ${wait}.`,
        }
      : undefined,
    windowRefusal(
      emailSends,
      signInCodePolicy.sendsPerEmail,
      (wait) => `Too many sign-in codes were requested for this email. Try again in ${wait}.`,
    ),
    windowRefusal(
      clientSends,
      signInCodePolicy.sendsPerClient,
      (wait) => `Too many sign-in codes were requested from this network. Try again in ${wait}.`,
    ),
  ].filter((refusal) => refusal !== undefined);
  const binding = refusals.reduce<SendRefusal | undefined>(
    (latestRefusal, refusal) =>
      latestRefusal === undefined || refusal.until > latestRefusal.until ? refusal : latestRefusal,
    undefined,
  );
  if (binding === undefined) return undefined;
  const seconds = Math.max(1, Math.ceil((binding.until - now.getTime()) / 1000));
  return new TooManyRequests({
    detail: binding.detail(waitText(seconds)),
    retry_after_seconds: seconds,
  });
};

const lockSignInCodes = (tx: TransactionClient, key: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`sign-in-codes:${key}`}, 0))`);

const recentSends = (tx: TransactionClient, scope: SQL, since: Date) =>
  tx
    .select({ createdAt: authCodes.createdAt })
    .from(authCodes)
    .where(and(scope, gt(authCodes.createdAt, since)))
    .orderBy(asc(authCodes.createdAt))
    .pipe(Effect.map((rows) => rows.map((row) => row.createdAt)));

const requireActiveUser = (tx: TransactionClient, userId: Uuid) =>
  Effect.gen(function* () {
    const rows = yield* tx
      .select({ deletedAt: users.deletedAt })
      .from(users)
      .where(eq(users.id, userId))
      .for("share");
    const user = rows[0];
    if (user === undefined) return yield* new Unauthorized({ detail: "Invalid credentials" });
    if (user.deletedAt !== null) {
      return yield* new Unauthorized({ detail: "This account is being deleted" });
    }
  });

export const AuthServiceLive = Layer.effect(
  AuthService,
  Effect.gen(function* () {
    const db = yield* Database;
    const config = yield* AppConfig;
    const clock = yield* ClockService;
    const mailer = yield* Mailer;
    const tokens = yield* TokenService;
    const vaultsService = yield* VaultsService;

    const resolveApiKey = (rawKey: string) =>
      db
        .query((d) =>
          d
            .select({
              id: users.id,
              email: users.email,
              keyId: apiKeys.id,
              vaultIds: apiKeys.vaultIds,
              canAsk: apiKeys.canAsk,
              canChange: apiKeys.canChange,
              expiresAt: apiKeys.expiresAt,
              lastUsedAt: apiKeys.lastUsedAt,
            })
            .from(users)
            .innerJoin(apiKeys, eq(apiKeys.userId, users.id))
            .where(
              and(
                eq(apiKeys.keyHash, sha256Hex(rawKey)),
                eq(apiKeys.revoked, false),
                isNull(users.deletedAt),
              ),
            )
            .limit(1),
        )
        .pipe(Effect.orDie);

    const userIdFor = (tx: TransactionClient, email: Email) =>
      Effect.gen(function* () {
        const created = yield* tx
          .insert(users)
          .values({ id: Uuid.make(randomUUID(), { disableChecks: true }), email })
          .onConflictDoNothing({ target: users.email })
          .returning();
        const user =
          created[0] ?? firstUser(yield* tx.select().from(users).where(eq(users.email, email)).limit(1));
        return user.id;
      });

    const createApiKey = (userId: Uuid, label: string, grant: KeyGrant = {}) =>
      Effect.gen(function* () {
        const rawKey = yield* generateApiKey;
        const rows = yield* db.query((d) => d
          .insert(apiKeys)
          .values({
            id: Uuid.make(randomUUID(), { disableChecks: true }),
            userId,
            keyHash: sha256Hex(rawKey),
            label,
            revoked: false,
            vaultIds: grant.vaultIds === undefined || grant.vaultIds === null ? null : [...grant.vaultIds],
            canAsk: grant.canAsk ?? true,
            canChange: grant.canChange ?? true,
            expiresAt: grant.expiresAt ?? null,
          })
          .returning())
          .pipe(Effect.orDie);
        const row = rows[0];
        if (row === undefined) {
          throw new Error("api key insert returned no rows");
        }
        return {
          ...apiKeyResponse(row),
          raw_key: rawKey,
        };
      });

    const ensureUser = (emailInput: Email) =>
      Effect.gen(function* () {
        const email = normalizeEmail(emailInput);
        const userId = yield* db.transaction((tx) =>
          Effect.gen(function* () {
            const id = yield* userIdFor(tx, email);
            yield* requireActiveUser(tx, id);
            return id;
          }),
        );
        yield* vaultsService.ensureDefaultForUser(userId, email);
        return userId;
      });

    const findUser = (emailInput: Email) =>
      db
        .query((d) =>
          d
            .select({ id: users.id })
            .from(users)
            .where(and(eq(users.email, normalizeEmail(emailInput)), isNull(users.deletedAt)))
            .limit(1),
        )
        .pipe(Effect.map((rows) => Option.fromNullishOr(rows[0]?.id)));

    const issueTokenPair = (userId: Uuid) =>
      Effect.gen(function* () {
        const now = yield* clock.now;
        return yield* db.transaction((tx) =>
          Effect.gen(function* () {
            yield* requireActiveUser(tx, userId);
            const accessToken = yield* tokens.issueAccessToken(userId, now);
            const refreshToken = yield* generateRefreshToken;
            yield* tx.insert(refreshTokens).values({
              id: Uuid.make(randomUUID(), { disableChecks: true }),
              userId,
              tokenHash: sha256Hex(refreshToken),
              expiresAt: addDays(now, config.jwtRefreshExpiryDays),
              revoked: false,
            });
            return tokenPair(accessToken, refreshToken);
          }),
        );
      });

    return {
      requestCode: (emailInput, clientAddress) =>
        Effect.gen(function* () {
          const email = normalizeEmail(emailInput);
          if (config.suppressAuth) {
            return;
          }
          if (!mailer.configured) {
            return yield* new ServiceUnavailable({
              detail: "Email sign-in is not set up on this server",
            });
          }
          const code = yield* generateAuthCode;
          const now = yield* clock.now;
          yield* db.transaction((tx) =>
            Effect.gen(function* () {
              if (clientAddress !== null) yield* lockSignInCodes(tx, `client:${clientAddress}`);
              yield* lockSignInCodes(tx, `email:${email}`);
              const emailSends = yield* recentSends(
                tx,
                eq(authCodes.email, email),
                new Date(now.getTime() - signInCodePolicy.sendsPerEmail.windowMs),
              );
              const clientSends =
                clientAddress === null
                  ? []
                  : yield* recentSends(
                      tx,
                      eq(authCodes.clientAddress, clientAddress),
                      new Date(now.getTime() - signInCodePolicy.sendsPerClient.windowMs),
                    );
              const refusal = sendRefusal(now, emailSends, clientSends);
              if (refusal !== undefined) return yield* refusal;
              yield* tx
                .update(authCodes)
                .set({ used: true })
                .where(and(eq(authCodes.email, email), eq(authCodes.used, false)));
              yield* tx.insert(authCodes).values({
                id: Uuid.make(randomUUID(), { disableChecks: true }),
                email,
                codeHash: sha256Hex(code),
                expiresAt: addMinutes(now, config.authCodeExpiryMinutes),
                used: false,
                clientAddress,
                createdAt: now,
              });
            }),
          );
          yield* mailer.send({
            to: email,
            subject: "Your sign-in code",
            body: `Your Great Minds sign-in code is: ${code}\n\nExpires in ${config.authCodeExpiryMinutes} minutes.`,
          });
        }),
      verifyCode: (emailInput, code) =>
        Effect.gen(function* () {
          const email = normalizeEmail(emailInput);
          const now = yield* clock.now;
          const result = yield* db.transaction((tx) =>
            Effect.gen(function* () {
              if (!config.suppressAuth) {
                const active = yield* tx
                  .select()
                  .from(authCodes)
                  .where(
                    and(
                      eq(authCodes.email, email),
                      eq(authCodes.used, false),
                      gt(authCodes.expiresAt, now),
                    ),
                  )
                  .orderBy(desc(authCodes.createdAt))
                  .limit(1)
                  .for("update");
                const current = active[0];
                if (current === undefined) {
                  return Result.fail("Invalid or expired code");
                }
                if (current.codeHash !== sha256Hex(code)) {
                  const failedAttempts = current.failedAttempts + 1;
                  const remaining = signInCodePolicy.wrongGuessesPerCode - failedAttempts;
                  yield* tx
                    .update(authCodes)
                    .set({ failedAttempts, used: remaining <= 0 })
                    .where(eq(authCodes.id, current.id));
                  return Result.fail(
                    remaining <= 0
                      ? "Too many incorrect attempts. Request a new code."
                      : `Incorrect code. ${plural(remaining, "attempt")} left.`,
                  );
                }
                yield* tx.update(authCodes).set({ used: true }).where(eq(authCodes.id, current.id));
              }

              return Result.succeed(yield* userIdFor(tx, email));
            }),
          );
          if (Result.isFailure(result)) {
            return yield* new Unauthorized({ detail: result.failure });
          }
          const pair = yield* issueTokenPair(result.success);
          yield* vaultsService.ensureDefaultForUser(result.success, email);
          return pair;
        }),
      refresh: (refreshToken) =>
        Effect.gen(function* () {
          const now = yield* clock.now;
          return yield* db.transaction((tx) =>
            Effect.gen(function* () {
              const matches = yield* tx
                .update(refreshTokens)
                .set({ revoked: true })
                .where(
                  and(
                    eq(refreshTokens.tokenHash, sha256Hex(refreshToken)),
                    eq(refreshTokens.revoked, false),
                    gt(refreshTokens.expiresAt, now),
                  ),
                )
                .returning({ userId: refreshTokens.userId });
              const match = matches[0];
              if (match === undefined) {
                return yield* new Unauthorized({
                  detail: "Invalid or expired refresh token",
                });
              }
              yield* requireActiveUser(tx, match.userId);
              const accessToken = yield* tokens.issueAccessToken(match.userId, now);
              const nextRefreshToken = yield* generateRefreshToken;
              yield* tx.insert(refreshTokens).values({
                id: Uuid.make(randomUUID(), { disableChecks: true }),
                userId: match.userId,
                tokenHash: sha256Hex(nextRefreshToken),
                expiresAt: addDays(now, config.jwtRefreshExpiryDays),
                revoked: false,
              });
              return tokenPair(accessToken, nextRefreshToken);
            }),
          );
        }),
      issueTokenPair,
      authenticateBearer: (token) =>
        Effect.gen(function* () {
          const jwtResult = yield* Effect.result(tokens.verifyAccessToken(token));
          if (Result.isSuccess(jwtResult)) {
            const userRows = yield* db
              .query((d) =>
                d
                  .select()
                  .from(users)
                  .where(and(eq(users.id, jwtResult.success), isNull(users.deletedAt)))
                  .limit(1),
              )
              .pipe(Effect.orDie);
            const user = userRows[0];
            if (user !== undefined) {
              return {
                user_id: user.id,
                email: asEmail(user.email),
                credential_kind: "jwt",
                key_scope: null,
              };
            }
          }

          const apiKeyRows = yield* resolveApiKey(token);
          const apiKeyUser = apiKeyRows[0];
          const now = yield* clock.now;
          if (
            apiKeyUser !== undefined &&
            (apiKeyUser.expiresAt === null || apiKeyUser.expiresAt.getTime() > now.getTime())
          ) {
            if (
              apiKeyUser.lastUsedAt === null ||
              now.getTime() - apiKeyUser.lastUsedAt.getTime() > LAST_USED_RESOLUTION_MS
            )
              yield* db
                .query((d) =>
                  d.update(apiKeys).set({ lastUsedAt: now }).where(eq(apiKeys.id, apiKeyUser.keyId)),
                )
                .pipe(Effect.orDie);
            return {
              user_id: apiKeyUser.id,
              email: asEmail(apiKeyUser.email),
              credential_kind: "api_key",
              key_scope: {
                key_id: apiKeyUser.keyId,
                vault_ids: apiKeyUser.vaultIds,
                can_ask: apiKeyUser.canAsk,
                can_change: apiKeyUser.canChange,
              },
            };
          }
          return yield* new Unauthorized({ detail: "Invalid credentials" });
        }),
      createApiKey,
      ensureUser,
      findUser,
      listApiKeys: (userId) =>
        db
          .query((d) =>
            d
              .select()
              .from(apiKeys)
              .where(eq(apiKeys.userId, userId))
              .orderBy(desc(apiKeys.createdAt)),
          )
          .pipe(
            Effect.map((rows) => rows.map(apiKeyResponse)),
            Effect.orDie,
          ),
      revokeApiKey: (userId, keyId) =>
        Effect.gen(function* () {
          const rows = yield* db.query((d) => d
            .update(apiKeys)
            .set({ revoked: true })
            .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, userId)))
            .returning({ id: apiKeys.id }))
            .pipe(Effect.orDie);
          if (rows[0] === undefined) {
            return yield* new NotFound({ detail: "API key not found" });
          }
        }),
      purgeSignInCodesOnce: () =>
        Effect.gen(function* () {
          const now = yield* clock.now;
          const purged = yield* db.query((d) =>
            d
              .delete(authCodes)
              .where(
                and(
                  lt(authCodes.createdAt, new Date(now.getTime() - retentionMs)),
                  lt(authCodes.expiresAt, now),
                ),
              )
              .returning({ id: authCodes.id }),
          );
          return purged.length;
        }),
    } satisfies AuthServiceShape;
  }),
);

export const SignInCodeRetentionLoopLive = Layer.effectDiscard(
  Effect.flatMap(AuthService, (auth) =>
    backgroundLoop({
      failureEvent: "auth.sign_in_code_retention_failed",
      interval: "1 hour",
      tick: auth.purgeSignInCodesOnce(),
    }),
  ),
);
