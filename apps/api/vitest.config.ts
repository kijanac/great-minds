import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    alias: [
      { find: /^@great-minds\/core$/, replacement: `${root}/packages/core/src/index.ts` },
      { find: /^@great-minds\/core\/(.*)$/, replacement: `${root}/packages/core/src/$1.ts` },
      { find: /^@great-minds\/db$/, replacement: `${root}/packages/db/src/index.ts` },
      { find: /^@great-minds\/db\/(.*)$/, replacement: `${root}/packages/db/src/$1.ts` },
      { find: /^@great-minds\/domain$/, replacement: `${root}/packages/domain/src/index.ts` },
      { find: /^@great-minds\/domain\/(.*)$/, replacement: `${root}/packages/domain/src/$1.ts` },
      { find: /^@great-minds\/protocol-openai$/, replacement: `${root}/packages/protocol-openai/src/index.ts` },
      { find: /^@great-minds\/protocol-openai\/(.*)$/, replacement: `${root}/packages/protocol-openai/src/$1.ts` },
    ],
  },
});
