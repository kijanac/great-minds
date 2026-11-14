import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: [fileURLToPath(new URL("./test/worker-database.ts", import.meta.url))],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
