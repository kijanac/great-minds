import { randomUUID } from "node:crypto";

import {
  apiKeys,
  authCodes,
  Database,
  refreshTokens,
  users,
  vaultMemberships,
  vaults,
  webauthnChallenges,
  webauthnCredentials,
} from "@great-minds/database";
import type { TokenPair } from "@great-minds/domain";
import { and, desc, eq, ne } from "drizzle-orm";
import { Effect, Layer, Option, Redacted } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ClockService, makeTestClock } from "../src/clock.ts";
import { AppConfig, type AppConfigShape } from "../src/config.ts";
import { StructuredLogger, StructuredLoggerLive } from "../src/logging.ts";
import { makeTestMailer } from "../src/mailer.ts";
import { startServer } from "../src/server.ts";
import { makeAppLayer } from "../src/app-layer.ts";

const initialTime = new Date("2026-07-09T12:00:00.000Z");

type TestDbServices = AppConfig | Database | ClockService | StructuredLogger;

type TestState = {
  readonly started: Awaited<ReturnType<typeof startServer>>;
  readonly clock: ReturnType<typeof makeTestClock>;
  readonly mailer: ReturnType<typeof makeTestMailer>;
};

type ApiResponse = {
  readonly status: number;
  readonly body: unknown;
  readonly text: string;
};

let state: TestState | undefined;

const currentState = () => {
  if (state === undefined) {
    throw new Error("test state is not initialized");
  }
  return state;
};

const databaseUrl = () => {
  const value = process.env.DATABASE_URL;
  if (value === undefined || value.length === 0) {
    throw new Error("DATABASE_URL is required for integration tests");
  }
  return value;
};

const testConfig = (url: string): AppConfigShape => ({
  databaseUrl: Redacted.make(url),
  jwtSecret: Redacted.make("integration-test-jwt-secret"),
  jwtAccessExpiryMinutes: 30,
  jwtRefreshExpiryDays: 7,
  authCodeExpiryMinutes: 10,
  webauthnRpId: "localhost",
  webauthnOrigins: ["http://localhost:5173"],
  webauthnRpName: "Great Minds",
  resendApiKey: Option.none(),
  resendFromEmail: Option.none(),
  dataDir: "/tmp/great-minds-auth-storage",
  storageBackend: "local",
  r2AccountId: Option.none(),
  r2AccessKeyId: Option.none(),
  r2SecretAccessKey: Option.none(),
  r2BucketPrefix: "gm-test",
  openRouterApiKey: Option.none(),
  openRouterApiUrl: "https://openrouter.ai/api/v1",
  parallelApiKey: Option.none(),
  parallelSearchUrl: "https://api.parallel.ai/v1beta/search",
  queryModel: "z-ai/glm-5.2",
  queryFallbackModels: ["deepseek/deepseek-v3.2"],
  extractModel: "deepseek/deepseek-v3.2",
  mapModel: "deepseek/deepseek-v3.2",
  reduceModel: "anthropic/claude-sonnet-4.6",
  renderModel: "qwen/qwen3.6-plus",
  compileEnrichConcurrency: 1,
  compileWriteConcurrency: 1,
  compilePartitionTargetTokens: 100_000,
  compilePartitionMinFactor: 0.3,
  compilePartitionMaxFactor: 1.5,
  compilePremergeJaccardThreshold: 0.8,
  compileDeriveRelatedLimit: 20,
  pipelineConcurrency: 1,
  goldensRandomSeed: Option.none(),
  goldensClock: Option.none(),
  embeddingModel: "qwen/qwen3-embedding-8b",
  corsOrigins: ["http://localhost:5173"],
  suppressAuth: false,
  serverHost: "127.0.0.1",
  serverPort: 0,
});

const buildTestState = async () => {
  const clock = makeTestClock(initialTime);
  const mailer = makeTestMailer();
  const configLayer = Layer.succeed(AppConfig, testConfig(databaseUrl()));
  const appLayer = makeAppLayer({
    config: configLayer,
    clock: clock.layer,
    mailer: mailer.layer,
    logger: StructuredLoggerLive,
  });
  const started = await startServer({ layer: appLayer, host: "127.0.0.1", port: 0 });
  return { started, clock, mailer } satisfies TestState;
};

const runDb = <A>(effect: Effect.Effect<A, unknown, TestDbServices>) =>
  currentState().started.runtime.runPromise(effect);

const resetDatabase = () =>
  runDb(
    Effect.gen(function* () {
      const db = yield* Database;
      yield* db.delete(authCodes).pipe(Effect.orDie);
      yield* db.delete(webauthnChallenges).pipe(Effect.orDie);
      yield* db.delete(webauthnCredentials).pipe(Effect.orDie);
      yield* db.delete(users).pipe(Effect.orDie);
    }),
  );

const api = async (
  method: string,
  path: string,
  body?: unknown,
  bearer?: string,
): Promise<ApiResponse> => {
  const headers = new Headers();
  if (body !== undefined) {
    headers.set("content-type", "application/json");
  }
  if (bearer !== undefined) {
    headers.set("authorization", `Bearer ${bearer}`);
  }
  const response = await fetch(`${currentState().started.url}/v1${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = text === "" ? undefined : (JSON.parse(text) as unknown);
  return { status: response.status, body: parsed, text };
};

const rawApi = async (method: string, path: string, body?: unknown): Promise<ApiResponse> => {
  const headers = new Headers();
  if (body !== undefined) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(`${currentState().started.url}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = text === "" ? undefined : (JSON.parse(text) as unknown);
  return { status: response.status, body: parsed, text };
};

const asRecord = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected object response");
  }
  return value as Record<string, unknown>;
};

const asString = (value: unknown, label: string) => {
  if (typeof value !== "string") {
    throw new Error(`expected ${label} to be a string`);
  }
  return value;
};

const asArray = (value: unknown) => {
  if (!Array.isArray(value)) {
    throw new Error("expected array response");
  }
  return value;
};

const tokenPairFrom = (body: unknown): TokenPair => {
  const record = asRecord(body);
  const accessToken = asString(record.access_token, "access_token");
  const refreshToken = asString(record.refresh_token, "refresh_token");
  expect(record.token_type).toBe("bearer");
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: "bearer",
  };
};

const latestCode = () => {
  const messages = currentState().mailer.sent;
  const message = messages[messages.length - 1];
  if (message === undefined) {
    throw new Error("expected a test email");
  }
  const match = /\b\d{6}\b/.exec(message.body);
  if (match === null) {
    throw new Error("expected a numeric sign-in code in test email");
  }
  const code = match[0];
  if (code === undefined) {
    throw new Error("expected regex capture");
  }
  return code;
};

const firstRow = <A>(rows: readonly A[], label: string) => {
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`expected ${label}`);
  }
  return row;
};

const signIn = async (email: string) => {
  const request = await api("POST", "/auth/request-code", { email });
  expect(request.status).toBe(204);
  expect(request.text).toBe("");
  const verify = await api("POST", "/auth/verify-code", {
    email,
    code: latestCode(),
  });
  expect(verify.status).toBe(200);
  return tokenPairFrom(verify.body);
};

const encodedClientData = (challenge: string, type: "webauthn.create" | "webauthn.get") =>
  Buffer.from(
    JSON.stringify({
      type,
      challenge,
      origin: "http://localhost:5173",
    }),
  ).toString("base64url");

const failedRegistration = (challenge: string) => ({
  id: "ZmFrZS1jcmVkZW50aWFs",
  rawId: "ZmFrZS1jcmVkZW50aWFs",
  response: {
    clientDataJSON: encodedClientData(challenge, "webauthn.create"),
    attestationObject: "AA",
    transports: ["internal"],
  },
  authenticatorAttachment: "platform",
  clientExtensionResults: {},
  type: "public-key",
  name: "Test device",
});

const failedAuthentication = (challenge: string) => ({
  id: "dW5rbm93bi1jcmVkZW50aWFs",
  rawId: "dW5rbm93bi1jcmVkZW50aWFs",
  response: {
    clientDataJSON: encodedClientData(challenge, "webauthn.get"),
    authenticatorData: "AA",
    signature: "AA",
  },
  authenticatorAttachment: "platform",
  clientExtensionResults: {},
  type: "public-key",
});

const userByEmail = (email: string) =>
  runDb(
    Effect.gen(function* () {
      const db = yield* Database;
      const rows = yield* db
        .select()
        .from(users)
        .where(eq(users.email, email))
        .limit(1)
        .pipe(Effect.orDie);
      return firstRow(rows, `user ${email}`);
    }),
  );

const ownedVaults = (userId: string) =>
  runDb(
    Effect.gen(function* () {
      const db = yield* Database;
      return yield* db.select().from(vaults).where(eq(vaults.ownerId, userId)).pipe(Effect.orDie);
    }),
  );

describe("auth HTTP integration", () => {
  beforeAll(async () => {
    state = await buildTestState();
  });

  beforeEach(async () => {
    const current = currentState();
    current.clock.set(initialTime);
    current.mailer.sent.length = 0;
    await resetDatabase();
  });

  afterAll(async () => {
    const current = state;
    state = undefined;
    if (current !== undefined) {
      await current.started.close();
    }
  });

  it("requests codes, normalizes email, stores only hashes, invalidates older codes, and validates email input", async () => {
    const invalid = await api("POST", "/auth/request-code", { email: "not-email" });
    expect(invalid.status).toBe(422);
    expect(invalid.body).toEqual({ detail: "Invalid request body" });

    const oversizedEmail = `${"a".repeat(309)}@example.com`;
    const oversized = await api("POST", "/auth/request-code", { email: oversizedEmail });
    expect(oversized.status).toBe(422);
    expect(oversized.body).toEqual({ detail: "Invalid request body" });

    const first = await api("POST", "/auth/request-code", { email: "Person@Example.COM" });
    expect(first.status).toBe(204);
    const firstCode = latestCode();

    const second = await api("POST", "/auth/request-code", { email: "person@example.com" });
    expect(second.status).toBe(204);
    const secondCode = latestCode();
    expect(secondCode).toMatch(/^\d{6}$/);

    const rows = await runDb(
      Effect.gen(function* () {
        const db = yield* Database;
        return yield* db
          .select()
          .from(authCodes)
          .where(eq(authCodes.email, "person@example.com"))
          .orderBy(desc(authCodes.createdAt))
          .pipe(Effect.orDie);
      }),
    );
    expect(rows).toHaveLength(2);
    const newest = firstRow(rows, "newest auth code");
    const older = rows[1];
    if (older === undefined) {
      throw new Error("expected older auth code");
    }
    expect(newest.codeHash).not.toBe(secondCode);
    expect(newest.codeHash).toMatch(/^[a-f0-9]{64}$/);
    expect(older.codeHash).not.toBe(firstCode);
    expect(older.used).toBe(true);
  });

  it("mounts auth only under /v1 and preserves framework wrong-method behavior", async () => {
    const root = await rawApi("GET", "/");
    expect(root.status).toBe(200);
    expect(root.body).toEqual({ status: "ok" });

    const rootHead = await rawApi("HEAD", "/");
    expect(rootHead.status).toBe(200);
    expect(rootHead.text).toBe("");

    const health = await rawApi("GET", "/health");
    expect(health.status).toBe(200);
    expect(health.body).toEqual({ status: "ok" });

    const unprefixed = await rawApi("POST", "/auth/request-code", {
      email: "mount@example.com",
    });
    expect(unprefixed.status).toBe(404);

    const wrongMethod = await rawApi("GET", "/v1/auth/request-code");
    expect(wrongMethod.status).toBe(404);
  });

  it("verifies codes, creates users and default vaults, and rejects wrong, used, and expired codes", async () => {
    await api("POST", "/auth/request-code", { email: "login@example.com" });
    const code = latestCode();
    const wrongCode = code === "000000" ? "999999" : "000000";
    const wrong = await api("POST", "/auth/verify-code", {
      email: "login@example.com",
      code: wrongCode,
    });
    expect(wrong.status).toBe(401);
    expect(wrong.body).toEqual({ detail: "Invalid or expired code" });

    const verify = await api("POST", "/auth/verify-code", {
      email: "LOGIN@example.com",
      code,
    });
    expect(verify.status).toBe(200);
    const pair = tokenPairFrom(verify.body);
    expect(pair.access_token.length).toBeGreaterThan(20);
    expect(pair.refresh_token.length).toBeGreaterThan(20);

    const reuse = await api("POST", "/auth/verify-code", {
      email: "login@example.com",
      code,
    });
    expect(reuse.status).toBe(401);
    expect(reuse.body).toEqual({ detail: "Invalid or expired code" });

    const user = await userByEmail("login@example.com");
    const userVaults = await ownedVaults(user.id);
    expect(userVaults).toHaveLength(1);
    expect(firstRow(userVaults, "default vault").name).toBe("login@example.com's vault");

    await api("POST", "/auth/request-code", { email: "expired@example.com" });
    const expiredCode = latestCode();
    currentState().clock.set(new Date(initialTime.getTime() + 11 * 60 * 1000));
    const expired = await api("POST", "/auth/verify-code", {
      email: "expired@example.com",
      code: expiredCode,
    });
    expect(expired.status).toBe(401);
    expect(expired.body).toEqual({ detail: "Invalid or expired code" });
  });

  it("rotates refresh tokens and rejects reused or expired refresh tokens", async () => {
    const pair = await signIn("refresh@example.com");

    const refresh = await api("POST", "/auth/refresh", {
      refresh_token: pair.refresh_token,
    });
    expect(refresh.status).toBe(200);
    const rotated = tokenPairFrom(refresh.body);
    expect(rotated.refresh_token).not.toBe(pair.refresh_token);

    const withRotatedAccessToken = await api(
      "GET",
      "/auth/api-keys",
      undefined,
      rotated.access_token,
    );
    expect(withRotatedAccessToken.status).toBe(200);
    expect(withRotatedAccessToken.body).toEqual([]);

    const reused = await api("POST", "/auth/refresh", {
      refresh_token: pair.refresh_token,
    });
    expect(reused.status).toBe(401);
    expect(reused.body).toEqual({ detail: "Invalid or expired refresh token" });

    const rows = await runDb(
      Effect.gen(function* () {
        const db = yield* Database;
        return yield* db.select().from(refreshTokens).pipe(Effect.orDie);
      }),
    );
    expect(rows.filter((row) => row.revoked)).toHaveLength(1);

    const expiredPair = await signIn("refresh-expired@example.com");
    currentState().clock.set(new Date(initialTime.getTime() + 8 * 24 * 60 * 60 * 1000));
    const expired = await api("POST", "/auth/refresh", {
      refresh_token: expiredPair.refresh_token,
    });
    expect(expired.status).toBe(401);
    expect(expired.body).toEqual({ detail: "Invalid or expired refresh token" });
  });

  it("authenticates protected routes with JWT and bearer API keys and rejects missing or expired credentials", async () => {
    const pair = await signIn("protected@example.com");

    const missing = await api("GET", "/auth/api-keys");
    expect(missing.status).toBe(401);
    expect(missing.body).toEqual({ detail: "Invalid credentials" });

    const create = await api("POST", "/auth/api-keys", { label: "automation" }, pair.access_token);
    expect(create.status).toBe(201);
    const created = asRecord(create.body);
    const rawKey = asString(created.raw_key, "raw_key");
    expect(rawKey.startsWith("gm_")).toBe(true);

    const withApiKey = await api("GET", "/auth/api-keys", undefined, rawKey);
    expect(withApiKey.status).toBe(200);
    const apiKeyList = asArray(withApiKey.body);
    expect(apiKeyList).toHaveLength(1);

    const deleted = await api(
      "DELETE",
      `/auth/api-keys/${asString(created.id, "api key id")}`,
      undefined,
      pair.access_token,
    );
    expect(deleted.status).toBe(204);

    const withRevokedApiKey = await api("GET", "/auth/api-keys", undefined, rawKey);
    expect(withRevokedApiKey.status).toBe(401);
    expect(withRevokedApiKey.body).toEqual({ detail: "Invalid credentials" });

    currentState().clock.set(new Date(initialTime.getTime() + 31 * 60 * 1000));
    const expiredJwt = await api("GET", "/auth/api-keys", undefined, pair.access_token);
    expect(expiredJwt.status).toBe(401);
    expect(expiredJwt.body).toEqual({ detail: "Invalid credentials" });
  });

  it("rejects malformed verify-code and refresh bodies", async () => {
    const malformedVerify = await api("POST", "/auth/verify-code", {
      email: "malformed@example.com",
    });
    expect(malformedVerify.status).toBe(422);
    expect(malformedVerify.body).toEqual({ detail: "Invalid request body" });

    const malformedRefresh = await api("POST", "/auth/refresh", {});
    expect(malformedRefresh.status).toBe(422);
    expect(malformedRefresh.body).toEqual({ detail: "Invalid request body" });
  });

  it("answers CORS preflight and echoes an allowed origin, rejecting others", async () => {
    const base = currentState().started.url;
    const allowed = "http://localhost:5173";

    const preflight = await fetch(`${base}/v1/auth/request-code`, {
      method: "OPTIONS",
      headers: {
        origin: allowed,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type,authorization",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(allowed);
    expect(preflight.headers.get("access-control-allow-headers")?.toLowerCase()).toContain(
      "authorization",
    );

    const actual = await fetch(`${base}/v1/auth/request-code`, {
      method: "POST",
      headers: { origin: allowed, "content-type": "application/json" },
      body: JSON.stringify({ email: "cors@example.com" }),
    });
    expect(actual.headers.get("access-control-allow-origin")).toBe(allowed);

    // A disallowed origin must never be echoed back as allowed. With a single
    // configured origin the middleware emits that origin statically, so the
    // browser-enforced boundary is "the response never grants the evil origin
    // itself" rather than "no header at all".
    const rejected = await fetch(`${base}/v1/auth/request-code`, {
      method: "OPTIONS",
      headers: { origin: "https://evil.example.com", "access-control-request-method": "POST" },
    });
    expect(rejected.headers.get("access-control-allow-origin")).not.toBe(
      "https://evil.example.com",
    );
  });

  it("creates discoverable passkey options, persists two-minute single-use challenges, and enforces auth", async () => {
    const unauthenticatedRegistration = await api("POST", "/auth/passkeys/register-options");
    expect(unauthenticatedRegistration.status).toBe(401);

    const pair = await signIn("passkey-options@example.com");
    const user = await userByEmail("passkey-options@example.com");
    await runDb(
      Effect.gen(function* () {
        const db = yield* Database;
        yield* db
          .insert(webauthnChallenges)
          .values({
            challenge: "expired-challenge",
            kind: "authentication",
            userId: null,
            expiresAt: new Date(initialTime.getTime() - 1),
          })
          .pipe(Effect.orDie);
      }),
    );

    const authentication = await api("POST", "/auth/passkeys/options");
    expect(authentication.status).toBe(200);
    const authenticationOptions = asRecord(authentication.body);
    const authenticationChallenge = asString(
      authenticationOptions.challenge,
      "authentication challenge",
    );
    expect(authenticationOptions.rpId).toBe("localhost");
    expect(authenticationOptions.allowCredentials).toEqual([]);
    expect(authenticationOptions.userVerification).toBe("required");

    const registration = await api(
      "POST",
      "/auth/passkeys/register-options",
      undefined,
      pair.access_token,
    );
    expect(registration.status).toBe(200);
    const registrationOptions = asRecord(registration.body);
    const registrationChallenge = asString(registrationOptions.challenge, "registration challenge");
    expect(asRecord(registrationOptions.rp)).toEqual({
      id: "localhost",
      name: "Great Minds",
    });
    expect(asRecord(registrationOptions.user).name).toBe("passkey-options@example.com");
    expect(registrationOptions.excludeCredentials).toEqual([]);
    expect(asRecord(registrationOptions.authenticatorSelection)).toMatchObject({
      residentKey: "required",
      userVerification: "required",
    });
    const unauthenticatedRegister = await api(
      "POST",
      "/auth/passkeys/register",
      failedRegistration(registrationChallenge),
    );
    expect(unauthenticatedRegister.status).toBe(401);

    const challenges = await runDb(
      Effect.gen(function* () {
        const db = yield* Database;
        return yield* db.select().from(webauthnChallenges).pipe(Effect.orDie);
      }),
    );
    expect(challenges).toHaveLength(2);
    expect(challenges).not.toContainEqual(
      expect.objectContaining({ challenge: "expired-challenge" }),
    );
    expect(challenges).toContainEqual(
      expect.objectContaining({
        challenge: authenticationChallenge,
        kind: "authentication",
        userId: null,
        expiresAt: new Date(initialTime.getTime() + 2 * 60 * 1000),
      }),
    );
    expect(challenges).toContainEqual(
      expect.objectContaining({
        challenge: registrationChallenge,
        kind: "registration",
        userId: user.id,
        expiresAt: new Date(initialTime.getTime() + 2 * 60 * 1000),
      }),
    );

    const unauthenticatedList = await api("GET", "/auth/passkeys");
    expect(unauthenticatedList.status).toBe(401);
    const unauthenticatedDelete = await api("DELETE", `/auth/passkeys/${randomUUID()}`);
    expect(unauthenticatedDelete.status).toBe(401);
  });

  it("consumes registration challenges once even when cryptographic verification fails", async () => {
    const pair = await signIn("passkey-register-failure@example.com");
    const options = await api(
      "POST",
      "/auth/passkeys/register-options",
      undefined,
      pair.access_token,
    );
    const challenge = asString(asRecord(options.body).challenge, "registration challenge");
    const response = failedRegistration(challenge);

    const first = await api("POST", "/auth/passkeys/register", response, pair.access_token);
    expect(first.status).toBe(422);
    expect(first.body).toEqual({
      detail: "Passkey registration could not be verified",
    });
    expect(JSON.stringify(first.body)).not.toContain(challenge);

    const second = await api("POST", "/auth/passkeys/register", response, pair.access_token);
    expect(second.status).toBe(422);
    expect(second.body).toEqual({
      detail: "Passkey registration could not be verified",
    });

    const remaining = await runDb(
      Effect.gen(function* () {
        const db = yield* Database;
        return yield* db
          .select()
          .from(webauthnChallenges)
          .where(eq(webauthnChallenges.challenge, challenge))
          .pipe(Effect.orDie);
      }),
    );
    expect(remaining).toEqual([]);
  });

  it("returns the same sanitized 401 for unknown passkeys and reused authentication challenges", async () => {
    const options = await api("POST", "/auth/passkeys/options");
    const challenge = asString(asRecord(options.body).challenge, "authentication challenge");
    const response = failedAuthentication(challenge);

    const first = await api("POST", "/auth/passkeys/verify", response);
    expect(first.status).toBe(401);
    expect(first.body).toEqual({ detail: "Passkey authentication failed" });
    expect(JSON.stringify(first.body)).not.toContain(challenge);

    const second = await api("POST", "/auth/passkeys/verify", response);
    expect(second.status).toBe(401);
    expect(second.body).toEqual({ detail: "Passkey authentication failed" });
  });

  it("lists only safe passkey metadata and restricts deletion to the owner", async () => {
    const ownerPair = await signIn("passkey-owner@example.com");
    const otherPair = await signIn("passkey-other@example.com");
    const owner = await userByEmail("passkey-owner@example.com");
    const other = await userByEmail("passkey-other@example.com");
    const ownerCredentialId = randomUUID();
    const otherCredentialId = randomUUID();
    await runDb(
      Effect.gen(function* () {
        const db = yield* Database;
        yield* db
          .insert(webauthnCredentials)
          .values([
            {
              id: ownerCredentialId,
              userId: owner.id,
              credentialId: "b3duZXItY3JlZGVudGlhbA",
              publicKey: "AQID",
              signCount: 3,
              transports: ["internal", "hybrid"],
              name: "Owner laptop",
              createdAt: new Date("2026-07-01T09:00:00.000Z"),
              lastUsedAt: new Date("2026-07-08T10:00:00.000Z"),
            },
            {
              id: otherCredentialId,
              userId: other.id,
              credentialId: "b3RoZXItY3JlZGVudGlhbA",
              publicKey: "BAUG",
              signCount: 0,
              transports: ["usb"],
              name: "Other key",
              createdAt: new Date("2026-07-02T09:00:00.000Z"),
              lastUsedAt: null,
            },
          ])
          .pipe(Effect.orDie);
      }),
    );

    const listed = await api("GET", "/auth/passkeys", undefined, ownerPair.access_token);
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([
      {
        id: ownerCredentialId,
        name: "Owner laptop",
        created_at: "2026-07-01T09:00:00.000Z",
        last_used_at: "2026-07-08T10:00:00.000Z",
        transports: ["internal", "hybrid"],
      },
    ]);
    expect(JSON.stringify(listed.body)).not.toContain("public");
    expect(JSON.stringify(listed.body)).not.toContain("credential_id");
    expect(JSON.stringify(listed.body)).not.toContain("sign_count");

    const deleteOther = await api(
      "DELETE",
      `/auth/passkeys/${otherCredentialId}`,
      undefined,
      ownerPair.access_token,
    );
    expect(deleteOther.status).toBe(404);
    expect(deleteOther.body).toEqual({ detail: "Passkey not found" });

    const otherStillListed = await api("GET", "/auth/passkeys", undefined, otherPair.access_token);
    expect(asArray(otherStillListed.body)).toHaveLength(1);

    const deleteOwn = await api(
      "DELETE",
      `/auth/passkeys/${ownerCredentialId}`,
      undefined,
      ownerPair.access_token,
    );
    expect(deleteOwn.status).toBe(204);
    expect(deleteOwn.text).toBe("");

    const afterDelete = await api("GET", "/auth/passkeys", undefined, ownerPair.access_token);
    expect(afterDelete.body).toEqual([]);
  });

  it("creates, lists, and revokes API keys with ownership checks", async () => {
    const ownerPair = await signIn("keys@example.com");
    const otherPair = await signIn("other-keys@example.com");

    const firstCreate = await api(
      "POST",
      "/auth/api-keys",
      { label: "first" },
      ownerPair.access_token,
    );
    expect(firstCreate.status).toBe(201);
    const firstKey = asRecord(firstCreate.body);
    const firstKeyId = asString(firstKey.id, "first id");
    expect(asString(firstKey.raw_key, "first raw key").startsWith("gm_")).toBe(true);

    const secondCreate = await api(
      "POST",
      "/auth/api-keys",
      { label: "second" },
      ownerPair.access_token,
    );
    expect(secondCreate.status).toBe(201);
    const secondKey = asRecord(secondCreate.body);
    const secondKeyId = asString(secondKey.id, "second id");

    const otherCreate = await api(
      "POST",
      "/auth/api-keys",
      { label: "other" },
      otherPair.access_token,
    );
    expect(otherCreate.status).toBe(201);
    const otherKeyId = asString(asRecord(otherCreate.body).id, "other id");

    const notOwned = await api(
      "DELETE",
      `/auth/api-keys/${otherKeyId}`,
      undefined,
      ownerPair.access_token,
    );
    expect(notOwned.status).toBe(404);
    expect(notOwned.body).toEqual({ detail: "API key not found" });

    const malformed = await api(
      "DELETE",
      "/auth/api-keys/not-a-uuid",
      undefined,
      ownerPair.access_token,
    );
    expect(malformed.status).toBe(422);
    expect(malformed.body).toEqual({ detail: "Invalid path parameter" });

    const deleted = await api(
      "DELETE",
      `/auth/api-keys/${firstKeyId}`,
      undefined,
      ownerPair.access_token,
    );
    expect(deleted.status).toBe(204);

    const listed = await api("GET", "/auth/api-keys", undefined, ownerPair.access_token);
    expect(listed.status).toBe(200);
    const keys = asArray(listed.body).map(asRecord);
    expect(keys).toHaveLength(2);
    expect(keys.map((key) => key.label)).toEqual(["second", "first"]);
    expect(keys.map((key) => key.id)).toEqual([secondKeyId, firstKeyId]);
    const newestKey = firstRow(keys, "newest listed key");
    const olderKey = keys[1];
    if (olderKey === undefined) {
      throw new Error("expected older listed key");
    }
    expect(newestKey.raw_key).toBeUndefined();
    expect(olderKey.raw_key).toBeUndefined();
    expect(newestKey.revoked).toBe(false);
    expect(olderKey.revoked).toBe(true);

    const keyRows = await runDb(
      Effect.gen(function* () {
        const db = yield* Database;
        return yield* db
          .select()
          .from(apiKeys)
          .where(
            and(
              eq(apiKeys.id, firstKeyId),
              ne(apiKeys.keyHash, asString(firstKey.raw_key, "raw key")),
            ),
          )
          .pipe(Effect.orDie);
      }),
    );
    expect(keyRows).toHaveLength(1);
  });

  it("deletes the caller account, owned vault rows, and only that user's memberships", async () => {
    const ownerPair = await signIn("delete-me@example.com");
    await signIn("survivor@example.com");

    const deleteUser = await userByEmail("delete-me@example.com");
    const survivor = await userByEmail("survivor@example.com");
    const deleteUserVault = firstRow(await ownedVaults(deleteUser.id), "owned vault");
    const survivorVault = firstRow(await ownedVaults(survivor.id), "survivor vault");

    await runDb(
      Effect.gen(function* () {
        const db = yield* Database;
        yield* db
          .insert(vaultMemberships)
          .values({
            id: randomUUID(),
            vaultId: survivorVault.id,
            userId: deleteUser.id,
            role: "VIEWER",
          })
          .pipe(Effect.orDie);
      }),
    );

    const invalidConfirm = await api(
      "DELETE",
      "/auth/me",
      { confirm: "delete" },
      ownerPair.access_token,
    );
    expect(invalidConfirm.status).toBe(422);
    expect(invalidConfirm.body).toEqual({ detail: "Invalid request body" });

    const deleted = await api("DELETE", "/auth/me", { confirm: "DELETE" }, ownerPair.access_token);
    expect(deleted.status).toBe(204);

    const remaining = await runDb(
      Effect.gen(function* () {
        const db = yield* Database;
        const deletedUsers = yield* db
          .select()
          .from(users)
          .where(eq(users.id, deleteUser.id))
          .pipe(Effect.orDie);
        const deletedVaults = yield* db
          .select()
          .from(vaults)
          .where(eq(vaults.id, deleteUserVault.id))
          .pipe(Effect.orDie);
        const survivorVaults = yield* db
          .select()
          .from(vaults)
          .where(eq(vaults.id, survivorVault.id))
          .pipe(Effect.orDie);
        const deletedMemberships = yield* db
          .select()
          .from(vaultMemberships)
          .where(eq(vaultMemberships.userId, deleteUser.id))
          .pipe(Effect.orDie);
        return {
          deletedUsers,
          deletedVaults,
          survivorVaults,
          deletedMemberships,
        };
      }),
    );

    expect(remaining.deletedUsers).toHaveLength(0);
    expect(remaining.deletedVaults).toHaveLength(0);
    expect(remaining.survivorVaults).toHaveLength(1);
    expect(remaining.deletedMemberships).toHaveLength(0);
  });
});
