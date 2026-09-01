import { Email, type TokenPair } from "@great-minds/domain";
import { Effect, Schema } from "effect";

import { getVaultId, storeVaultId } from "../vault-selection";

import { api, run } from "./app";
import { TokenStore } from "./token-store";

const email = Schema.decodeSync(Email);
const firstPage = { limit: 50, offset: 0 } as const;

const selectDefaultVault = Effect.gen(function* () {
  const page = yield* api.vaults.listVaults({ query: firstPage });
  const first = page.items[0];
  if (first !== undefined) storeVaultId(first.id);
});

const storeSession = (tokens: TokenPair) =>
  Effect.gen(function* () {
    const store = yield* TokenStore;
    yield* store.write(tokens);
    yield* selectDefaultVault;
  });

export function requestCode(address: string): Promise<void> {
  return run(api.auth.requestCode({ payload: { email: email(address) } }));
}

export function loginWithCode(address: string, code: string): Promise<void> {
  return run(
    api.auth
      .verifyCode({ payload: { email: email(address), code } })
      .pipe(Effect.flatMap(storeSession)),
  );
}

export function loginWithTokenPair(tokens: TokenPair): Promise<void> {
  return run(storeSession(tokens));
}

export function logout(): Promise<void> {
  return run(Effect.flatMap(TokenStore, (store) => store.clear));
}

export function ensureVaultId(): Promise<void> {
  if (getVaultId() !== null) return Promise.resolve();
  return run(
    Effect.gen(function* () {
      const store = yield* TokenStore;
      const stored = yield* store.read;
      if (stored.access === null) return;
      yield* selectDefaultVault;
    }),
  );
}
