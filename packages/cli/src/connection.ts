import { makeApi, TokenStore } from "@great-minds/client";
import { Context, Effect, Layer } from "effect";

export class CliFetch extends Context.Service<CliFetch, typeof globalThis.fetch>()(
  "@great-minds/cli/Fetch",
) {}

export type Connection = ReturnType<typeof makeApi>;

const fixedToken = (token: string | null) =>
  Layer.succeed(TokenStore, {
    read: Effect.succeed({ session: token === null ? null : "cli", access: token, refresh: null }),
    write: () => Effect.void,
    clear: Effect.void,
    replaceIfCurrent: () => Effect.succeed(false),
    exclusive: (effect) => effect,
  });

export const connect = (apiUrl: string, token: string | null) =>
  Effect.gen(function* () {
    const fetch = yield* CliFetch;
    return makeApi({ baseUrl: apiUrl, fetch, tokens: fixedToken(token) });
  });
