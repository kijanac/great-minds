# Great Minds Tauri shell

Thin desktop wrapper for the existing Vite/React web app.

## Versions chosen May 2026

- Tauri runtime: `tauri = 2.11.x` (`2.11.0` released 2026-04-30; Cargo currently resolves `2.11.2`).
- Tauri build helper: `tauri-build = 2.6.x`.
- Tauri CLI: `@tauri-apps/cli = ^2.11.0`.

## Commands

From `web/`:

```bash
pnpm desktop:dev
pnpm desktop:build:debug
pnpm desktop:build
```

The Tauri config runs the existing Vite scripts:

- dev: `pnpm dev` at `http://localhost:5173`
- build: `pnpm build`, with static output loaded from `web/dist`

## Current architecture

This is intentionally a thin hosted-backend shell:

- refresh tokens are stored in the OS credential store via the Rust `keyring` crate
- no sidecars yet
- no local Postgres/backend worker yet
- packaged app falls back to `https://great-minds-api.onrender.com/v1` when running under Tauri's production origin

## Follow-up before shipping broadly

- Validate R2 presigned PUT upload from the packaged shell; R2 bucket CORS now receives Tauri origins when buckets are ensured. Run `great-minds sync-r2-cors` once after deploy to update existing buckets.
- Add native sidecars only after the hosted shell is stable.
- Move more auth traffic through native code if we want renderer JS to never hold short-lived access tokens either.
