# M5 — Staging parity, cutover, Python removal

**Parent plan:** `docs/ts-migration.md`. **Precondition:** M4 complete (`a572c3b`) — TS backend serves the full API surface and runs the full pipeline, gated by parity (126 requests / 51 endpoints), goldens (both lanes alpha-exact), 108 hermetic tests, and a live browser-smoke compile.

**Invariants:** the production Postgres and R2 data are the fixed point — cutover changes which process serves them, never the data itself. Rollback is one `git revert` + redeploy at every stage until Python removal. Single-user deployment: brief downtime and one forced re-login are acceptable.

## Current production topology (render.yaml)

- `great-minds-api` — Docker (Python), boot runs `alembic upgrade head` then uvicorn; health `/health`.
- `great-minds-worker` — same image, `great-minds worker` (Absurd).
- `great-minds-web` — static Vite build, `VITE_API_BASE` → the api service URL.
- `great-minds-db` — Render Postgres 18. Storage: R2, `gm-prod` prefix.

The TS backend collapses api + worker into **one service**: `main.ts` runs the HTTP server, the workflow engine (in-process SingleRunner, decision M4.2-2), and the compile-intents reconciler.

## M5.0 — Prep (no prod impact, lands on main)

1. **TS Dockerfile** (multi-stage: node:24-slim, pnpm workspace install with the supply-chain hold, run `packages/server/src/main.ts`; keep image lean, healthcheck `/health`).
2. **Schema-head assertion at boot:** TS never runs alembic. At boot it asserts `alembic_version.version_num` equals the pinned final revision and fails loudly on mismatch. The Effect engine keeps bootstrapping its own `cluster_*` tables (proven, decision M4.2-1).
3. **render.yaml cutover diff prepared but not merged:** `great-minds-api` switches to the TS Dockerfile (same service name and URL — frontend and CORS untouched); `great-minds-worker` is suspended/deleted.
4. Env deltas documented: `OPENROUTER_API_URL` (TS name) alongside the key; drop worker-only vars; JWT_SECRET decision below.

## M5.1 — Staging rehearsal on the real data (the go/no-go gate)

Run against a **copy** of prod, never prod itself:

1. Snapshot `great-minds-db` → scratch database (pg_dump/restore locally is sufficient; no paid staging services needed).
2. Copy the R2 bucket(s) `gm-prod*` → `gm-staging*` (rclone/aws-s3 CLI).
3. Boot Python and TS backends locally against the same staged copy (read paths) — run a **read-only staging parity sweep**: every read endpoint over the real corpus (vaults, wiki, sources, documents, chunks, links, search, sessions incl. markdown, lint, costs, jobs), responses diffed under the established decision rules. No mutations against real data — mutation parity is already covered by the fixture harness.
4. **The warm-cache no-op compile (the strongest single test):** on the staged copy the compile cache is fully warm from production. Trigger a TS compile with `OPENROUTER_API_URL` pointed at a dead port. It must complete green with **zero LLM calls** — every cache key TS constructs from the real prompts, models, and UUIDs must match the rows Python wrote, and rendered artifacts must be byte-stable. Any cache miss surfaces as a loud connection failure and is a cutover blocker.
5. TS staged-ingest smoke against the staging R2 copy (the one path local scratch could not exercise: presign → PUT → process → conversion → intent).
6. Browser smoke against the staged stack (login, wiki, query, session).

## M5.2 — Cutover (execution checklist)

1. Quiesce: confirm no in-flight Absurd tasks; drain per decision M4.2-8 (terminal-state all tasks, one final Python reconciler pass so intents receive `satisfied_at`; abandoned intents re-emitted post-cutover).
2. Final prod DB snapshot (rollback artifact).
3. Merge the render.yaml swap → push → Render deploys TS on the same api URL; suspend the worker service.
4. Verify: `/health`, schema-head assertion in logs, `determinism_pins_active` NOT in logs, login (re-login expected if JWT secret rotated), wiki reads, one query, one small ingest → reconciler dispatches → compile completes → cost row.
5. Rollback trigger at any failure: revert the render.yaml commit, redeploy Python api + resume worker. The DB is untouched by the swap itself; TS writes are Python-compatible by construction (parity + goldens), so a rollback after some TS traffic is safe — `cluster_*` rows are simply ignored by Python.

## M5.3 — Soak

Python stays deployable (image + config in git history) for the soak window. Watch: error logs, compile behavior on real edits, costs, zombie-recovery events. Exit criterion: at least one organic ingest→compile→publish cycle on real work, plus a week of normal use without a Python-shaped regression.

## M5.4 — Python removal (after soak)

1. Delete `src/great_minds/`, `pyproject.toml`, `uv.lock`, the Python Dockerfile stages, alembic tree (frozen; final revision recorded in the boot assertion).
2. **Schema ownership passes to drizzle-kit** (already the DDL source for scratch stacks in tests): future migrations are drizzle-kit generated against the same database; `alembic_version` remains as a historical marker until the first drizzle migration ships.
3. Retire the dual-backend harnesses into TS regression instruments: parity retires (its job is done); the goldens **TS lane becomes the permanent regression gate** (cassette + golden stay checked in); Python-lane code paths removed from the harness.
4. Absurd retirement migration: drop the `absurd` schema after confirming the drain left nothing needed.
5. Prompts: TS copies become canonical (drift guards against Python sources retire with the sources; the byte-guard tests flip to self-consistency between prompt file and cache-key hash).
6. justfile/CI prune (ruff/ty/uv recipes out; `review` = ci-full + goldens-check TS lane).

## Decisions (settled with Ki-Jana, 2026-07-15)

- **D1 Same-service swap:** `great-minds-api` switches to the TS image in place — same name, same URL, frontend and CORS untouched; rollback is one revert. Worker suspended at the same moment.
- **D2 JWT secret rotates:** one forced re-login at cutover; no secret handling.
- **D3 Staging = local backends over a staged copy of prod data** (pg_dump + R2 prefix copy); no paid staging services.
- **D4 drizzle-kit owns the schema after Python removal;** alembic freezes at its final revision, asserted at boot.
