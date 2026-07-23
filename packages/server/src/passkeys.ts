import { randomUUID } from "node:crypto";

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { decodeClientDataJSON, isoBase64URL, isoUint8Array } from "@simplewebauthn/server/helpers";
import type {
  AuthenticationExtensionsClientOutputs,
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  Base64URLString,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { Database, webauthnChallenges, webauthnCredentials } from "@great-minds/database";
import {
  AuthenticatorTransport,
  NotFound,
  PasskeyAuthenticationOptions,
  PasskeyRegistrationOptions,
  Unauthorized,
  Validation,
} from "@great-minds/domain";
import type {
  Email,
  Passkey,
  PasskeyAuthentication,
  PasskeyRegistration,
  TokenPair,
  Uuid,
} from "@great-minds/domain";
import { and, desc, eq, isNull, lte } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";

import { AuthService } from "./auth.ts";
import { ClockService } from "./clock.ts";
import { AppConfig } from "./config.ts";
import { dieDatabase } from "./db-defects.ts";
import { StructuredLogger } from "./logging.ts";

type CredentialRow = typeof webauthnCredentials.$inferSelect;
type ChallengeKind = "registration" | "authentication";

type PasskeysServiceShape = {
  readonly registrationOptions: (
    userId: Uuid,
    email: Email,
  ) => Effect.Effect<PasskeyRegistrationOptions>;
  readonly register: (
    userId: Uuid,
    registration: PasskeyRegistration,
  ) => Effect.Effect<Passkey, Validation>;
  readonly authenticationOptions: () => Effect.Effect<PasskeyAuthenticationOptions>;
  readonly verify: (response: PasskeyAuthentication) => Effect.Effect<TokenPair, Unauthorized>;
  readonly list: (userId: Uuid) => Effect.Effect<readonly Passkey[]>;
  readonly delete: (userId: Uuid, credentialId: Uuid) => Effect.Effect<void, NotFound>;
};

export class PasskeysService extends Context.Service<PasskeysService, PasskeysServiceShape>()(
  "@great-minds/server/PasskeysService",
) {}

const REGISTRATION_FAILURE = "Passkey registration could not be verified";
const AUTHENTICATION_FAILURE = "Passkey authentication failed";
const CHALLENGE_EXPIRY_MINUTES = 2;

const addMinutes = (date: Date, minutes: number) => new Date(date.getTime() + minutes * 60 * 1000);

const asUuid = (value: string): Uuid => value as Uuid;

const jsonProtocolValue = (value: unknown): unknown => JSON.parse(JSON.stringify(value)) as unknown;

const transportsFromDatabase = (transports: readonly string[]) =>
  Schema.decodeUnknownSync(Schema.Array(AuthenticatorTransport))(transports);

const passkeyResponse = (row: CredentialRow): Passkey => ({
  id: asUuid(row.id),
  name: row.name,
  created_at: row.createdAt.toISOString(),
  last_used_at: row.lastUsedAt?.toISOString() ?? null,
  transports: transportsFromDatabase(row.transports),
});

const registrationResponse = ({
  name: _name,
  ...response
}: PasskeyRegistration): RegistrationResponseJSON => ({
  ...response,
  response: {
    ...response.response,
    transports:
      response.response.transports === undefined ? undefined : [...response.response.transports],
  },
  clientExtensionResults: response.clientExtensionResults as AuthenticationExtensionsClientOutputs,
});

const authenticationResponse = (response: PasskeyAuthentication): AuthenticationResponseJSON => ({
  ...response,
  clientExtensionResults: response.clientExtensionResults as AuthenticationExtensionsClientOutputs,
});

const registrationFailure = () => new Validation({ detail: REGISTRATION_FAILURE });
const authenticationFailure = () => new Unauthorized({ detail: AUTHENTICATION_FAILURE });
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const PasskeysServiceLive = Layer.effect(
  PasskeysService,
  Effect.gen(function* () {
    const auth = yield* AuthService;
    const clock = yield* ClockService;
    const config = yield* AppConfig;
    const db = yield* Database;
    const logger = yield* StructuredLogger;

    const failRegistration = (message: string, userId: Uuid) =>
      logger
        .warn("passkey_registration_failed", {
          error_message: message,
          user_id: userId,
        })
        .pipe(Effect.andThen(Effect.fail(registrationFailure())));

    const failAuthentication = (message: string, userId?: string) =>
      logger
        .warn("passkey_authentication_failed", {
          error_message: message,
          user_id: userId,
        })
        .pipe(Effect.andThen(Effect.fail(authenticationFailure())));

    const deleteExpiredChallenges = (now: Date) =>
      db.delete(webauthnChallenges).where(lte(webauthnChallenges.expiresAt, now)).pipe(dieDatabase);

    const persistChallenge = (
      challenge: string,
      kind: ChallengeKind,
      userId: Uuid | null,
      now: Date,
    ) =>
      db
        .insert(webauthnChallenges)
        .values({
          challenge,
          kind,
          userId,
          expiresAt: addMinutes(now, CHALLENGE_EXPIRY_MINUTES),
        })
        .pipe(dieDatabase);

    const consumeChallenge = <E>(
      clientDataJSON: string,
      kind: ChallengeKind,
      userId: Uuid | null,
      now: Date,
      onFailure: (message: string) => Effect.Effect<never, E>,
    ) =>
      Effect.gen(function* () {
        const challenge = yield* Effect.try({
          try: () => decodeClientDataJSON(clientDataJSON as Base64URLString).challenge,
          catch: (error) => error,
        }).pipe(Effect.catch((error) => onFailure(errorMessage(error))));
        const rows = yield* db
          .delete(webauthnChallenges)
          .where(
            and(
              eq(webauthnChallenges.challenge, challenge),
              eq(webauthnChallenges.kind, kind),
              userId === null
                ? isNull(webauthnChallenges.userId)
                : eq(webauthnChallenges.userId, userId),
            ),
          )
          .returning()
          .pipe(dieDatabase);
        const consumed = rows[0];
        if (consumed === undefined || consumed.expiresAt <= now) {
          return yield* onFailure("Challenge is missing, expired, or already used");
        }
        return consumed.challenge;
      });

    return {
      registrationOptions: (userId, email) =>
        Effect.gen(function* () {
          const now = yield* clock.now;
          yield* deleteExpiredChallenges(now);
          const credentials = yield* db
            .select({
              credentialId: webauthnCredentials.credentialId,
              transports: webauthnCredentials.transports,
            })
            .from(webauthnCredentials)
            .where(eq(webauthnCredentials.userId, userId))
            .pipe(dieDatabase);
          const options = yield* Effect.tryPromise(() =>
            generateRegistrationOptions({
              rpName: config.webauthnRpName,
              rpID: config.webauthnRpId,
              userID: isoUint8Array.fromUTF8String(userId),
              userName: email,
              userDisplayName: email,
              attestationType: "none",
              excludeCredentials: credentials.map((credential) => ({
                id: credential.credentialId as Base64URLString,
                transports: transportsFromDatabase(
                  credential.transports,
                ) as AuthenticatorTransportFuture[],
              })),
              authenticatorSelection: {
                residentKey: "required",
                userVerification: "preferred",
              },
            }),
          ).pipe(Effect.orDie);
          yield* persistChallenge(options.challenge, "registration", userId, now);
          return Schema.decodeUnknownSync(PasskeyRegistrationOptions)(jsonProtocolValue(options));
        }),
      register: (userId, registration) =>
        Effect.gen(function* () {
          const now = yield* clock.now;
          const response = registrationResponse(registration);
          const challenge = yield* consumeChallenge(
            response.response.clientDataJSON,
            "registration",
            userId,
            now,
            (message) => failRegistration(message, userId),
          );
          const verification = yield* Effect.tryPromise({
            try: () =>
              verifyRegistrationResponse({
                response,
                expectedChallenge: challenge,
                expectedOrigin: [...config.webauthnOrigins],
                expectedRPID: config.webauthnRpId,
              }),
            catch: (error) => error,
          }).pipe(Effect.catch((error) => failRegistration(errorMessage(error), userId)));
          if (!verification.verified) {
            return yield* failRegistration("Verification returned false", userId);
          }
          const credential = verification.registrationInfo.credential;
          const rows = yield* db
            .insert(webauthnCredentials)
            .values({
              id: randomUUID(),
              userId,
              credentialId: credential.id,
              publicKey: isoBase64URL.fromBuffer(credential.publicKey),
              signCount: credential.counter,
              transports: credential.transports ?? [],
              name: registration.name.trim(),
            })
            .returning()
            .pipe(dieDatabase);
          const row = rows[0];
          if (row === undefined) {
            throw new Error("WebAuthn credential insert returned no row");
          }
          return passkeyResponse(row);
        }),
      authenticationOptions: () =>
        Effect.gen(function* () {
          const now = yield* clock.now;
          yield* deleteExpiredChallenges(now);
          const options = yield* Effect.tryPromise(() =>
            generateAuthenticationOptions({
              rpID: config.webauthnRpId,
              allowCredentials: [],
              userVerification: "preferred",
            }),
          ).pipe(Effect.orDie);
          yield* persistChallenge(options.challenge, "authentication", null, now);
          return Schema.decodeUnknownSync(PasskeyAuthenticationOptions)(jsonProtocolValue(options));
        }),
      verify: (authentication) =>
        Effect.gen(function* () {
          const now = yield* clock.now;
          const response = authenticationResponse(authentication);
          const challenge = yield* consumeChallenge(
            response.response.clientDataJSON,
            "authentication",
            null,
            now,
            failAuthentication,
          );
          const rows = yield* db
            .select()
            .from(webauthnCredentials)
            .where(eq(webauthnCredentials.credentialId, response.id))
            .limit(1)
            .pipe(dieDatabase);
          const credential = rows[0];
          if (credential === undefined) {
            return yield* failAuthentication("Credential is unknown");
          }
          const verification = yield* Effect.tryPromise({
            try: () =>
              verifyAuthenticationResponse({
                response,
                expectedChallenge: challenge,
                expectedOrigin: [...config.webauthnOrigins],
                expectedRPID: config.webauthnRpId,
                credential: {
                  id: credential.credentialId as Base64URLString,
                  publicKey: isoBase64URL.toBuffer(credential.publicKey),
                  counter: credential.signCount,
                  transports: transportsFromDatabase(
                    credential.transports,
                  ) as AuthenticatorTransportFuture[],
                },
              }),
            catch: (error) => error,
          }).pipe(
            Effect.catch((error) => failAuthentication(errorMessage(error), credential.userId)),
          );
          if (!verification.verified) {
            return yield* failAuthentication("Verification returned false", credential.userId);
          }
          yield* db
            .update(webauthnCredentials)
            .set({
              signCount: verification.authenticationInfo.newCounter,
              lastUsedAt: now,
            })
            .where(eq(webauthnCredentials.id, credential.id))
            .pipe(dieDatabase);
          return yield* auth.issueTokenPair(asUuid(credential.userId));
        }),
      list: (userId) =>
        db
          .select()
          .from(webauthnCredentials)
          .where(eq(webauthnCredentials.userId, userId))
          .orderBy(desc(webauthnCredentials.createdAt))
          .pipe(
            Effect.map((rows) => rows.map(passkeyResponse)),
            dieDatabase,
          ),
      delete: (userId, credentialId) =>
        Effect.gen(function* () {
          const rows = yield* db
            .delete(webauthnCredentials)
            .where(
              and(eq(webauthnCredentials.id, credentialId), eq(webauthnCredentials.userId, userId)),
            )
            .returning({ id: webauthnCredentials.id })
            .pipe(dieDatabase);
          if (rows[0] === undefined) {
            return yield* new NotFound({ detail: "Passkey not found" });
          }
        }),
    } satisfies PasskeysServiceShape;
  }),
);
