import { fileURLToPath } from "node:url";

import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: fileURLToPath(new URL("./packages/database/src/schema.ts", import.meta.url)),
  out: fileURLToPath(new URL("./packages/database/drizzle", import.meta.url)),
  dialect: "postgresql",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      "postgresql://great_minds:great_minds@localhost:55433/gm_spike"
  },
  strict: true,
  verbose: true
});
