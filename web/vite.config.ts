import tailwindcss from "@tailwindcss/vite";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["src/**/*.test.ts"],
          exclude: ["src/**/*.mounted.test.ts"],
        },
      },
      {
        extends: true,
        resolve: { conditions: ["browser"] },
        test: {
          name: "mounted",
          environment: "jsdom",
          include: ["src/**/*.mounted.test.ts"],
          execArgv: ["--no-experimental-webstorage"],
        },
      },
    ],
  },
  server: {
    proxy: {
      // Match vault-scoped reply tails before the general API proxy.
      "^/api/vaults/[^/]+/replies/[^/]+/stream": {
        target: "http://localhost:8000",
        rewrite: (path) => path.replace(/^\/api/, "/v1"),
        configure: (proxy) => {
          proxy.on("proxyRes", (proxyRes) => {
            // Disable buffering for SSE
            proxyRes.headers["cache-control"] = "no-cache";
            proxyRes.headers["x-accel-buffering"] = "no";
          });
        },
      },
      "/api": {
        target: "http://localhost:8000",
        rewrite: (path) => path.replace(/^\/api/, "/v1"),
      },
    },
  },
});
