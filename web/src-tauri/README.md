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

This is still primarily a thin hosted-backend shell:

- refresh tokens are stored in the OS credential store via the Rust `keyring` crate
- packaged app falls back to `https://great-minds-api.onrender.com/v1` when no local backend is started
- an opt-in FastAPI sidecar spike can start a local API process and point the web app at `http://127.0.0.1:<port>/v1`
- no local Postgres provisioning yet
- no local worker sidecar yet

## FastAPI sidecar spike

For the local-first spike, the easiest path is Docker Compose owning Postgres/API/worker:

```bash
docker compose --profile desktop up --build
GREAT_MINDS_DESKTOP_API_BASE=http://127.0.0.1:8000/v1 pnpm desktop:dev
```

The compose profile runs:

- Postgres + pgvector on `localhost:5432`
- API on `localhost:8000` after `alembic upgrade head`
- worker after `alembic upgrade head`
- local bootstrap auth with `LOCAL_MODE=true`
- app-owned dev data at `${GREAT_MINDS_DATA_DIR:-./var/desktop-data}` mounted as `/data`

In local mode the desktop app calls `/v1/local/bootstrap` and opens the workspace without the email-code flow.

The shell can also start a local backend process directly when explicitly requested:

```bash
GREAT_MINDS_DESKTOP_START_BACKEND=1 pnpm desktop:dev
```

By default this runs from the repo root:

```bash
uv run great-minds serve --host 127.0.0.1 --port {port}
```

Override the command or working directory when needed:

```bash
GREAT_MINDS_DESKTOP_BACKEND_CMD="uv run great-minds serve --host 127.0.0.1 --port {port}" \
GREAT_MINDS_DESKTOP_BACKEND_CWD="/path/to/great_minds" \
pnpm desktop:dev
```

Direct sidecar mode inherits the Tauri process environment, so it still needs `DATABASE_URL`, `JWT_SECRET`, and other normal backend settings. This does not package Python/Postgres yet.

## Follow-up before shipping broadly

- Validate R2 presigned PUT upload from the packaged shell; R2 bucket CORS now receives Tauri origins when buckets are ensured. Run `great-minds sync-r2-cors` once after deploy to update existing buckets.
- Add native sidecars only after the hosted shell is stable.
- Move more auth traffic through native code if we want renderer JS to never hold short-lived access tokens either.
