import { jwtVerify, SignJWT } from "jose";

import { Context, Effect, Layer, Redacted, Schema } from "effect";

import { Unauthorized, Uuid } from "@great-minds/domain";

import { ClockService } from "./clock.ts";
import { AppConfig } from "./config.ts";

const encoder = new TextEncoder();
const AccessTokenClaims = Schema.Struct({ type: Schema.Literal("access"), sub: Uuid });

type TokenServiceShape = {
  readonly issueAccessToken: (userId: Uuid, now: Date) => Effect.Effect<string>;
  readonly verifyAccessToken: (token: string) => Effect.Effect<Uuid, Unauthorized>;
};

export class TokenService extends Context.Service<TokenService, TokenServiceShape>()(
  "@great-minds/server/TokenService"
) {}

const secretKey = (secret: Redacted.Redacted<string>) => encoder.encode(Redacted.value(secret));

const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

export const TokenServiceLive = Layer.effect(
  TokenService,
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const clock = yield* ClockService;
    return {
      issueAccessToken: (userId, now) =>
        Effect.promise(() =>
          new SignJWT({
            sub: userId,
            type: "access",
          })
            .setProtectedHeader({ alg: "HS256", typ: "JWT" })
            .setIssuedAt(seconds(now))
            .setExpirationTime(seconds(now) + config.jwtAccessExpiryMinutes * 60)
            .sign(secretKey(config.jwtSecret)),
        ),
      verifyAccessToken: (token) =>
        Effect.gen(function* () {
          const now = yield* clock.now;
          const verified = yield* Effect.tryPromise(() =>
            jwtVerify(token, secretKey(config.jwtSecret), {
              algorithms: ["HS256"],
              currentDate: now,
            }),
          );
          const claims = yield* Schema.decodeUnknownEffect(AccessTokenClaims)(verified.payload);
          return claims.sub;
        }).pipe(Effect.mapError(() => new Unauthorized({ detail: "Invalid credentials" }))),
    } satisfies TokenServiceShape;
  }),
);
