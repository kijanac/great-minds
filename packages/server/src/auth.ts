import { randomUUID } from "node:crypto";

import { apiKeys, authCodes, Database, refreshTokens, users } from "@great-minds/database";
import { Email, NotFound, Unauthorized } from "@great-minds/domain";
import type { ApiKey, ApiKeyWithSecret, AuthContext, TokenPair, Uuid } from "@great-minds/domain";
import { and, desc, eq, gt } from "drizzle-orm";
import { Context, Effect, Layer, Result, Schema } from "effect";

import { ClockService } from "./clock.ts";
import { AppConfig } from "./config.ts";
import { generateApiKey, generateAuthCode, generateRefreshToken, sha256Hex } from "./crypto.ts";
import { Mailer } from "./mailer.ts";
import { ContentStorage, userOwner } from "./storage.ts";
import { TokenService } from "./tokens.ts";
import { VaultsService } from "./vaults.ts";

type UserRow = typeof users.$inferSelect;
type ApiKeyRow = typeof apiKeys.$inferSelect;

type AuthServiceShape = {
  readonly requestCode: (email: Email) => Effect.Effect<void>;
  readonly verifyCode: (email: Email, code: string) => Effect.Effect<TokenPair, Unauthorized>;
  readonly refresh: (refreshToken: string) => Effect.Effect<TokenPair, Unauthorized>;
  readonly issueTokenPair: (userId: Uuid) => Effect.Effect<TokenPair>;
  readonly authenticateBearer: (token: string) => Effect.Effect<AuthContext, Unauthorized>;
  readonly createApiKey: (userId: Uuid, label: string) => Effect.Effect<ApiKeyWithSecret>;
  readonly listApiKeys: (userId: Uuid) => Effect.Effect<readonly ApiKey[]>;
  readonly revokeApiKey: (userId: Uuid, keyId: Uuid) => Effect.Effect<void, NotFound>;
  readonly deleteSelf: (userId: Uuid) => Effect.Effect<void, NotFound>;
};

export class AuthService extends Context.Service<AuthService, AuthServiceShape>()(
  "@great-minds/server/AuthService",
) {}

const normalizeEmail = (email: Email): Email =>
  Schema.decodeUnknownSync(Email)(email.trim().toLowerCase());

const asUuid = (value: string): Uuid => value as Uuid;

const asEmail = (value: string): Email => value as Email;

const addMinutes = (date: Date, minutes: number) => new Date(date.getTime() + minutes * 60 * 1000);

const addDays = (date: Date, days: number) => new Date(date.getTime() + days * 24 * 60 * 60 * 1000);

const tokenPair = (accessToken: string, refreshToken: string): TokenPair => ({
  access_token: accessToken,
  refresh_token: refreshToken,
  token_type: "bearer",
});

const apiKeyResponse = (row: ApiKeyRow): ApiKey => ({
  id: asUuid(row.id),
  label: row.label,
  created_at: row.createdAt.toISOString(),
  revoked: row.revoked,
});

const firstUser = (rows: readonly UserRow[]) => {
  const row = rows[0];
  if (row === undefined) {
    throw new Error("expected user row");
  }
  return row;
};

export const AuthServiceLive = Layer.effect(
  AuthService,
  Effect.gen(function* () {
    const db = yield* Database;
    const config = yield* AppConfig;
    const clock = yield* ClockService;
    const mailer = yield* Mailer;
    const storage = yield* ContentStorage;
    const tokens = yield* TokenService;
    const vaultsService = yield* VaultsService;

    const resolveApiKey = (rawKey: string) =>
      db.query((d) => d
        .select({
          id: users.id,
          email: users.email,
        })
        .from(users)
        .innerJoin(apiKeys, eq(apiKeys.userId, users.id))
        .where(and(eq(apiKeys.keyHash, sha256Hex(rawKey)), eq(apiKeys.revoked, false)))
        .limit(1))
        .pipe(Effect.orDie);

    const issueTokenPair = (userId: Uuid) =>
      Effect.gen(function* () {
        const now = yield* clock.now;
        return yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              const accessToken = yield* tokens.issueAccessToken(userId, now);
              const refreshToken = yield* generateRefreshToken;
              yield* tx.insert(refreshTokens).values({
                id: randomUUID(),
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
      requestCode: (emailInput) =>
        Effect.gen(function* () {
          const email = normalizeEmail(emailInput);
          if (config.suppressAuth) {
            return;
          }
          const code = yield* generateAuthCode;
          const now = yield* clock.now;
          yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                yield* tx
                  .update(authCodes)
                  .set({ used: true })
                  .where(and(eq(authCodes.email, email), eq(authCodes.used, false)));
                yield* tx.insert(authCodes).values({
                  id: randomUUID(),
                  email,
                  codeHash: sha256Hex(code),
                  expiresAt: addMinutes(now, config.authCodeExpiryMinutes),
                  used: false,
                });
              }),
            )
            .pipe(Effect.orDie);
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
          const result = yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                if (!config.suppressAuth) {
                  const matches = yield* tx
                    .select()
                    .from(authCodes)
                    .where(
                      and(
                        eq(authCodes.email, email),
                        eq(authCodes.codeHash, sha256Hex(code)),
                        eq(authCodes.used, false),
                        gt(authCodes.expiresAt, now),
                      ),
                    )
                    .limit(1);
                  const match = matches[0];
                  if (match === undefined) {
                    return yield* new Unauthorized({ detail: "Invalid or expired code" });
                  }
                  yield* tx.update(authCodes).set({ used: true }).where(eq(authCodes.id, match.id));
                }

                const created = yield* tx
                  .insert(users)
                  .values({
                    id: randomUUID(),
                    email,
                  })
                  .onConflictDoNothing({ target: users.email })
                  .returning();
                const createdUser = created[0];
                const user =
                  createdUser !== undefined
                    ? createdUser
                    : firstUser(
                        yield* tx.select().from(users).where(eq(users.email, email)).limit(1),
                      );
                return asUuid(user.id);
              }),
            );
          const pair = yield* issueTokenPair(result);
          yield* vaultsService.ensureDefaultForUser(result, email);
          return pair;
        }),
      refresh: (refreshToken) =>
        Effect.gen(function* () {
          const now = yield* clock.now;
          return yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                const matches = yield* tx
                  .select()
                  .from(refreshTokens)
                  .where(
                    and(
                      eq(refreshTokens.tokenHash, sha256Hex(refreshToken)),
                      eq(refreshTokens.revoked, false),
                      gt(refreshTokens.expiresAt, now),
                    ),
                  )
                  .limit(1);
                const match = matches[0];
                if (match === undefined) {
                  return yield* new Unauthorized({
                    detail: "Invalid or expired refresh token",
                  });
                }
                yield* tx
                  .update(refreshTokens)
                  .set({ revoked: true })
                  .where(eq(refreshTokens.id, match.id));
                const accessToken = yield* tokens.issueAccessToken(asUuid(match.userId), now);
                const nextRefreshToken = yield* generateRefreshToken;
                yield* tx.insert(refreshTokens).values({
                  id: randomUUID(),
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
            const userRows = yield* db.query((d) => d
              .select()
              .from(users)
              .where(eq(users.id, jwtResult.success))
              .limit(1))
              .pipe(Effect.orDie);
            const user = userRows[0];
            if (user !== undefined) {
              return {
                user_id: asUuid(user.id),
                email: asEmail(user.email),
                credential_kind: "jwt",
              };
            }
          }

          const apiKeyRows = yield* resolveApiKey(token);
          const apiKeyUser = apiKeyRows[0];
          if (apiKeyUser !== undefined) {
            return {
              user_id: asUuid(apiKeyUser.id),
              email: asEmail(apiKeyUser.email),
              credential_kind: "api_key",
            };
          }
          return yield* new Unauthorized({ detail: "Invalid credentials" });
        }),
      createApiKey: (userId, label) =>
        Effect.gen(function* () {
          const rawKey = yield* generateApiKey;
          const rows = yield* db.query((d) => d
            .insert(apiKeys)
            .values({
              id: randomUUID(),
              userId,
              keyHash: sha256Hex(rawKey),
              label,
              revoked: false,
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
        }),
      listApiKeys: (userId) =>
        db.query((d) => d
          .select()
          .from(apiKeys)
          .where(eq(apiKeys.userId, userId))
          .orderBy(desc(apiKeys.createdAt)))
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
      deleteSelf: (userId) =>
        Effect.gen(function* () {
          yield* vaultsService.deleteOwnedVaults(userId);
          yield* storage.clear(userOwner(userId));
          const rows = yield* db.query((d) => d
            .delete(users)
            .where(eq(users.id, userId))
            .returning({ id: users.id }))
            .pipe(Effect.orDie);
          if (rows[0] === undefined) {
            return yield* new NotFound({ detail: "User not found" });
          }
        }),
    } satisfies AuthServiceShape;
  }),
);
