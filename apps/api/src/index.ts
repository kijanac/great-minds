import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { createApiRuntime } from "./runtime.js";
import { authCodeDeliveryFromEnv, env, openAiProviderFromEnv } from "./env.js";

const config = {
  auth: {
    jwtSecret: env.JWT_SECRET,
    jwtAccessExpiryMinutes: env.JWT_ACCESS_EXPIRY_MINUTES,
    jwtRefreshExpiryDays: env.JWT_REFRESH_EXPIRY_DAYS,
    authCodeExpiryMinutes: env.AUTH_CODE_EXPIRY_MINUTES,
    suppressAuth: env.SUPPRESS_AUTH,
  },
  authCodeDelivery: authCodeDeliveryFromEnv(),
  openAiProvider: openAiProviderFromEnv(),
};
const runtime = await createApiRuntime({ connectionString: env.DATABASE_URL }, config);
const app = createApp(runtime, config);

const server = serve(
  {
    fetch: app.fetch,
    port: env.PORT,
  },
  (info) => {
    console.log(`Great Minds API listening on port ${info.port}`);
  },
);

async function shutdown() {
  await runtime.dispose();
  server.close();
}

process.on("SIGINT", () => {
  void shutdown().then(() => process.exit(0));
});

process.on("SIGTERM", () => {
  void shutdown().then(() => process.exit(0));
});
