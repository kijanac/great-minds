import type { TokenPair } from "@great-minds/domain";
import { Context, type Effect } from "effect";

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

export class TokenStore extends Context.Service<TokenStore, TokenStoreShape>()(
  "@great-minds/client/TokenStore",
) {}
