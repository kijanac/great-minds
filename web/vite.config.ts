import path from "path"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

const host = process.env.TAURI_DEV_HOST

export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    host: host || false,
    port: 5173,
    strictPort: true,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 5174,
        }
      : undefined,
    proxy: {
      // Match vault-scoped SSE endpoint: /api/vaults/{id}/query/stream
      "^/api/vaults/[^/]+/query/stream": {
        target: "http://localhost:8000",
        rewrite: (path) => path.replace(/^\/api/, "/v1"),
        configure: (proxy) => {
          proxy.on("proxyRes", (proxyRes) => {
            // Disable buffering for SSE
            proxyRes.headers["cache-control"] = "no-cache"
            proxyRes.headers["x-accel-buffering"] = "no"
          })
        },
      },
      "/api": {
        target: "http://localhost:8000",
        rewrite: (path) => path.replace(/^\/api/, "/v1"),
      },
    },
  },
})
