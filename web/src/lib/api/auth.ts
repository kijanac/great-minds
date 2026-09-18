import { Email, type TokenPair } from "@great-minds/domain";
import { Effect, Schema } from "effect";

import { api, run } from "./app";
import { TokenStore } from "./token-store";

const email = Schema.decodeSync(Email);
const storeSession = (tokens: TokenPair) =>
  Effect.flatMap(TokenStore, (store) => store.write(tokens));

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
