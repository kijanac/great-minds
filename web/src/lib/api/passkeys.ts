import { PasskeyRegistration, type Passkey } from "@great-minds/domain";
import type { RegistrationResponseJSON } from "@simplewebauthn/browser";
import { Schema } from "effect";

import { api, run } from "./app";

export async function registerPasskey(
  name: string,
  response: RegistrationResponseJSON,
): Promise<Passkey> {
  return run(
    api.auth.registerPasskey({
      payload: Schema.decodeSync(PasskeyRegistration)({ ...response, name }),
    }),
  );
}
