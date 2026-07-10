import { jwtVerify, SignJWT } from "jose";

import { Context, Effect, Layer, Redacted, Schema } from "effect";

import { Unauthorized, Uuid } from "@great-minds/domain";

import { ClockService } from "./clock.ts";
import { AppConfig } from "./config.ts";

const encoder = new TextEncoder();

export type TokenServiceShape = {
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
            type: "access"
          })
            .setProtectedHeader({ alg: "HS256", typ: "JWT" })
            .setIssuedAt(seconds(now))
            .setExpirationTime(seconds(now) + config.jwtAccessExpiryMinutes * 60)
            .sign(secretKey(config.jwtSecret))
        ),
      verifyAccessToken: (token) =>
        Effect.gen(function* () {
          const now = yield* clock.now;
          return yield* Effect.tryPromise({
            try: async () => {
              const verified = await jwtVerify(token, secretKey(config.jwtSecret), {
                algorithms: ["HS256"],
                currentDate: now
              });
              if (verified.payload.type !== "access") {
                throw new Error("not access token");
              }
              return Schema.decodeUnknownSync(Uuid)(verified.payload.sub);
            },
            catch: () => new Unauthorized({ detail: "Invalid credentials" })
          });
        })
    } satisfies TokenServiceShape;
  })
);
