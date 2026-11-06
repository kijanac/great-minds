import { makeApi, TokenStore, type StoredTokens } from "@great-minds/client";
import type { TokenPair } from "@great-minds/domain";
import { Context, Effect, Layer, Ref, Semaphore } from "effect";

export class CliFetch extends Context.Service<CliFetch, typeof globalThis.fetch>()(
  "@great-minds/cli/Fetch",
) {}

export type Connection = ReturnType<typeof makeApi>;

const signedOut: StoredTokens = { session: null, access: null, refresh: null };

const apiKeyTokens = (apiKey: string) =>
  Layer.succeed(TokenStore, {
    read: Effect.succeed({ session: "api-key", access: apiKey, refresh: null }),
    write: () => Effect.void,
    clear: Effect.void,
    replaceIfCurrent: () => Effect.succeed(false),
    exclusive: (effect) => effect,
  });

const sessionTokens = (state: Ref.Ref<StoredTokens>, lock: Semaphore.Semaphore) =>
  Layer.succeed(TokenStore, {
    read: Ref.get(state),
    write: (tokens: TokenPair) =>
      Ref.set(state, {
        session: "login",
        access: tokens.access_token,
        refresh: tokens.refresh_token,
      }),
    clear: Ref.set(state, signedOut),
    replaceIfCurrent: (expected, tokens) =>
      Ref.modify(state, (current) =>
        current.session === expected.session &&
        current.access === expected.access &&
        current.refresh === expected.refresh
          ? [
              true,
              tokens === null
                ? signedOut
                : { session: "login", access: tokens.access_token, refresh: tokens.refresh_token },
            ]
          : [false, current],
      ),
    exclusive: lock.withPermits(1),
  });

export const connectWithKey = (apiUrl: string, apiKey: string) =>
  Effect.gen(function* () {
    const fetch = yield* CliFetch;
    return makeApi({ baseUrl: apiUrl, fetch, tokens: apiKeyTokens(apiKey) });
  });

export const connectForLogin = (apiUrl: string) =>
  Effect.gen(function* () {
    const fetch = yield* CliFetch;
    const state = yield* Ref.make(signedOut);
    const lock = yield* Semaphore.make(1);
    const connection = makeApi({ baseUrl: apiUrl, fetch, tokens: sessionTokens(state, lock) });
    const signIn = (tokens: TokenPair) =>
      Ref.set(state, {
        session: "login",
        access: tokens.access_token,
        refresh: tokens.refresh_token,
      });
    return { connection, signIn };
  });
