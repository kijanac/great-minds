import { serve } from "@hono/node-server";
import { createBackendContext } from "@great-minds/db/context";
import { createApp } from "./app.js";
import { authCodeDeliveryFromEnv, env, openAiProviderFromEnv } from "./env.js";

const backend = await createBackendContext({ connectionString: env.DATABASE_URL });
const app = createApp(backend.db, {
  auth: {
    jwtSecret: env.JWT_SECRET,
    jwtAccessExpiryMinutes: env.JWT_ACCESS_EXPIRY_MINUTES,
    jwtRefreshExpiryDays: env.JWT_REFRESH_EXPIRY_DAYS,
    authCodeExpiryMinutes: env.AUTH_CODE_EXPIRY_MINUTES,
    suppressAuth: env.SUPPRESS_AUTH,
  },
  authCodeDelivery: authCodeDeliveryFromEnv(),
  openAiProvider: openAiProviderFromEnv(),
});

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
  await backend.runtime.dispose();
  server.close();
}

process.on("SIGINT", () => {
  void shutdown().then(() => process.exit(0));
});

process.on("SIGTERM", () => {
  void shutdown().then(() => process.exit(0));
});
