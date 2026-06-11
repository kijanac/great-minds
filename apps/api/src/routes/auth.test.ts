import { Effect, Layer, ManagedRuntime } from "effect";
import { describe, expect, test } from "vitest";
import {
  AuthCodeDelivery,
  AuthCodeDeliveryFailed,
  AuthConfig,
  AuthServiceLive,
  type AuthConfigService,
} from "@great-minds/core/auth";
import { Db, type BackendDb } from "@great-minds/db/context";
import { createApp } from "../app.js";
import type { ApiConfig } from "../context.js";
import type { ApiRuntime } from "../runtime.js";

const baseAuthConfig: AuthConfigService = {
  jwtSecret: "test-secret-test-secret-test-secret-test-secret",
  jwtAccessExpiryMinutes: 15,
  jwtRefreshExpiryDays: 30,
  authCodeExpiryMinutes: 10,
};

const baseConfig: ApiConfig = {
  auth: baseAuthConfig,
  authCodeDelivery: { kind: "console" },
  openAiProvider: { kind: "disabled" },
};

describe("POST /v1/auth/request-code", () => {
  test("returns 204 when an auth code can be requested", async () => {
    const app = createApp(fakeRuntime(), baseConfig);

    const response = await requestCode(app);

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  test("returns 502 when auth code delivery fails", async () => {
    const app = createApp(
      fakeRuntime({
        deliver: () => Effect.fail(new AuthCodeDeliveryFailed({ message: "Failed to send auth code" })),
      }),
      baseConfig,
    );

    const response = await requestCode(app);

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: { message: "Failed to send auth code" } });
  });
});

function requestCode(app: ReturnType<typeof createApp>) {
  return app.request("/v1/auth/request-code", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "Test@GreatMinds.local" }),
  });
}

function fakeRuntime({
  auth = baseAuthConfig,
  deliver = () => Effect.void,
}: {
  auth?: AuthConfigService;
  deliver?: (email: string, code: string, expiresInMinutes: number) => Effect.Effect<void, AuthCodeDeliveryFailed>;
} = {}): ApiRuntime {
  const dbLayer = Layer.succeed(Db, fakeDb());
  const authConfigLayer = Layer.succeed(AuthConfig, AuthConfig.of(auth));
  const authCodeDeliveryLayer = Layer.succeed(AuthCodeDelivery, AuthCodeDelivery.of({ deliver }));
  const authLayer = AuthServiceLive.pipe(Layer.provide(Layer.mergeAll(dbLayer, authConfigLayer, authCodeDeliveryLayer)));
  return ManagedRuntime.make(Layer.mergeAll(dbLayer, authLayer)) as ApiRuntime;
}

function fakeDb(): BackendDb {
  return {
    update: () => ({
      set: () => ({
        where: () => Effect.void,
      }),
    }),
    insert: () => ({
      values: () => Effect.void,
    }),
  } as unknown as BackendDb;
}
