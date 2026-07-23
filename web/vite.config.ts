import tailwindcss from "@tailwindcss/vite";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  server: {
    proxy: {
      // Match vault-scoped SSE endpoint: /api/vaults/{id}/query/stream
      "^/api/vaults/[^/]+/query/stream": {
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
