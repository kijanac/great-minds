import type { TokenPair } from "@great-minds/domain";
import { Context, Effect, Layer, Semaphore } from "effect";

import { clearVaultId } from "../vault-selection";

export interface StoredTokens {
  readonly session: string | null;
  readonly access: string | null;
  readonly refresh: string | null;
}

export interface TokenStoreShape {
  readonly read: Effect.Effect<StoredTokens>;
  readonly write: (tokens: TokenPair) => Effect.Effect<void>;
  readonly clear: Effect.Effect<void>;
  readonly replaceIfCurrent: (
    expected: StoredTokens,
    tokens: TokenPair | null,
  ) => Effect.Effect<boolean>;
  readonly exclusive: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

export class TokenStore extends Context.Service<TokenStore, TokenStoreShape>()("web/TokenStore") {}

const SESSION_KEY = "auth_session";
const ACCESS_KEY = "access_token";
const REFRESH_KEY = "refresh_token";
const TOKEN_LOCK = "great-minds-auth-tokens";

const announce = () => window.dispatchEvent(new Event("auth:changed"));

export const readStoredTokens = (): StoredTokens => ({
  session: localStorage.getItem(SESSION_KEY),
  access: localStorage.getItem(ACCESS_KEY),
  refresh: localStorage.getItem(REFRESH_KEY),
});

const writeTokens = (tokens: TokenPair) => {
  localStorage.setItem(ACCESS_KEY, tokens.access_token);
  localStorage.setItem(REFRESH_KEY, tokens.refresh_token);
  announce();
};

const clear = () => {
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(ACCESS_KEY);
  localStorage.removeItem(REFRESH_KEY);
  clearVaultId();
  announce();
};

const acquireBrowserLock = (locks: LockManager) =>
  Effect.callback<() => void>((resume, signal) => {
    locks
      .request(TOKEN_LOCK, { signal }, () =>
        signal.aborted
          ? undefined
          : new Promise<void>((release) => resume(Effect.succeed(() => release()))),
      )
      .catch((error: unknown) => {
        if (!signal.aborted) resume(Effect.die(error));
      });
  });

const holdingBrowserLock =
  (locks: LockManager) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const release = yield* restore(acquireBrowserLock(locks));
        return yield* restore(effect).pipe(Effect.ensuring(Effect.sync(release)));
      }),
    );

export const TokenStoreLive = Layer.effect(
  TokenStore,
  Effect.gen(function* () {
    const tabOnly = yield* Semaphore.make(1);
    return {
      read: Effect.sync(readStoredTokens),
      write: (tokens) =>
        Effect.sync(() => {
          localStorage.setItem(SESSION_KEY, crypto.randomUUID());
          writeTokens(tokens);
        }),
      clear: Effect.sync(clear),
      replaceIfCurrent: (expected, tokens) =>
        Effect.sync(() => {
          const current = readStoredTokens();
          if (
            current.session !== expected.session ||
            current.access !== expected.access ||
            current.refresh !== expected.refresh
          )
            return false;
          if (tokens === null) clear();
          else writeTokens(tokens);
          return true;
        }),
      exclusive: (effect) => {
        const locks = globalThis.navigator?.locks;
        return locks === undefined
          ? tabOnly.withPermits(1)(effect)
          : holdingBrowserLock(locks)(effect);
      },
    } satisfies TokenStoreShape;
  }),
);
