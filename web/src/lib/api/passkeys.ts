import { PasskeyRegistration, type Passkey } from "@great-minds/domain";
import type { RegistrationResponseJSON } from "@simplewebauthn/browser";
import { Effect } from "effect";

import { api, run } from "./app";
import { decodeInput } from "./runtime";

export function registerPasskey(
  name: string,
  response: RegistrationResponseJSON,
): Promise<Passkey> {
  return run(
    Effect.gen(function* () {
      const payload = yield* decodeInput(PasskeyRegistration, { ...response, name });
      return yield* api.auth.registerPasskey({ payload });
    }),
  );
}
