import type { TokenPair } from "@great-minds/domain";
import { Context, Effect, Layer } from "effect";

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
}

export class TokenStore extends Context.Service<TokenStore, TokenStoreShape>()("web/TokenStore") {}

const SESSION_KEY = "auth_session";
const ACCESS_KEY = "access_token";
const REFRESH_KEY = "refresh_token";

const announce = () => window.dispatchEvent(new Event("auth:changed"));

const read = (): StoredTokens => ({
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

export const TokenStoreLive = Layer.succeed(TokenStore, {
  read: Effect.sync(read),
  write: (tokens) =>
    Effect.sync(() => {
      localStorage.setItem(SESSION_KEY, crypto.randomUUID());
      writeTokens(tokens);
    }),
  clear: Effect.sync(clear),
  replaceIfCurrent: (expected, tokens) =>
    Effect.sync(() => {
      const current = read();
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
});
