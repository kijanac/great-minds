import type { TokenPair } from "@great-minds/domain";
import { Context, Effect, Layer } from "effect";

import { clearVaultId } from "../vault-selection";

export interface StoredTokens {
  readonly access: string | null;
  readonly refresh: string | null;
}

export interface TokenStoreShape {
  readonly read: Effect.Effect<StoredTokens>;
  readonly write: (tokens: TokenPair) => Effect.Effect<void>;
  readonly clear: Effect.Effect<void>;
}

export class TokenStore extends Context.Service<TokenStore, TokenStoreShape>()("web/TokenStore") {}

const ACCESS_KEY = "access_token";
const REFRESH_KEY = "refresh_token";

const announce = () => window.dispatchEvent(new Event("auth:changed"));

export const TokenStoreLive = Layer.succeed(TokenStore, {
  read: Effect.sync(() => ({
    access: localStorage.getItem(ACCESS_KEY),
    refresh: localStorage.getItem(REFRESH_KEY),
  })),
  write: (tokens) =>
    Effect.sync(() => {
      localStorage.setItem(ACCESS_KEY, tokens.access_token);
      localStorage.setItem(REFRESH_KEY, tokens.refresh_token);
      announce();
    }),
  clear: Effect.sync(() => {
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
    clearVaultId();
  }),
});
