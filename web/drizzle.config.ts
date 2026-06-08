import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/local/db/schema.ts",
  out: "./src/local/db/migrations",
  dialect: "postgresql",
  strict: true,
  verbose: true,
});
