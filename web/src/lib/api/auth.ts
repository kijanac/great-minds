import { Email, type TokenPair } from "@great-minds/domain";
import { Effect } from "effect";

import { api, run } from "./app";
import { TokenStore } from "./token-store";
import { decodeInput } from "./runtime";
const storeSession = (tokens: TokenPair) =>
  Effect.flatMap(TokenStore, (store) => store.exclusive(store.write(tokens)));

export function requestCode(address: string): Promise<void> {
  return run(
    Effect.gen(function* () {
      const email = yield* decodeInput(Email, address);
      yield* api.auth.requestCode({ payload: { email } });
    }),
  );
}

export function loginWithCode(address: string, code: string): Promise<void> {
  return run(
    Effect.gen(function* () {
      const email = yield* decodeInput(Email, address);
      const tokens = yield* api.auth.verifyCode({ payload: { email, code } });
      yield* storeSession(tokens);
    }),
  );
}

export function loginWithTokenPair(tokens: TokenPair): Promise<void> {
  return run(storeSession(tokens));
}

export function logout(): Promise<void> {
  return run(Effect.flatMap(TokenStore, (store) => store.exclusive(store.clear)));
}
