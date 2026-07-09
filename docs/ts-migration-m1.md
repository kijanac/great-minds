# M1 — TypeScript backend foundation: auth + read paths

**Parent plan:** `docs/ts-migration.md` (read it first — goal, invariants, adopted stack posture A). **Prerequisite evidence:** `SPIKE_REPORT.md` on branch `spike/effect-v4-stack`.

**Objective:** a TypeScript service (`packages/server`) that serves the existing auth flow and all read-only APIs for vaults, wiki, documents, sources, and sessions — **byte-compatible with the Python backend's HTTP contract** — such that the React app runs correctly against either backend by switching `VITE_API_BASE`.

## Step 0 — land the spike, fix the toolchain

1. Merge `spike/effect-v4-stack` into `main`. The spike's `packages/` code is scaffolding, not a style template: rewrite each file to the house rules (below) as M1 touches it; delete `workflow-official.ts`'s proof harness paranoia (env guards, kill flags) when workflow code moves to product use (not in M1).
2. Make `just ci` pass on main with the new packages present, without `--no-verify`:
   - Resolve the pnpm `minimumReleaseAge` conflict properly (scoped exclusion for the pinned `effect`/`drizzle` pre-releases, or an equivalent policy adjustment — not a blanket disable).
   - Fix the `lint-web` deps-status failure mode (workspace-change → interactive purge abort) so hooks run headless.
   - Add the three packages to CI: tsgo typecheck + oxlint (adopt the repo's existing lint config shape).
3. Keep the exact spike version pins (`effect@4.0.0-beta.94` set, `drizzle-orm@1.0.0-rc.4`). One deliberate coordinated pin-bump is allowed at M1 completion if needed; never mid-task.

## Scope

**In:** exact-contract TS implementations of:

| Resource | Source of truth (Python) | Surface |
|---|---|---|
| Auth | `app/api/auth_routes.py` | request-code (Resend email), verify-code, refresh, api-keys list/create/delete, me delete — full JWT + refresh + API-key semantics from `core/auth/` + `core/crypto.py`. Tokens must be mutually verifiable across backends (same alg/secret/claims). |
| Vaults | `app/api/vault_routes.py` | list/get, memberships, config read. Role checks (`owner`/`editor`/`viewer`) enforced identically. |
| Wiki | `app/api/wiki_routes.py` | article index (pagination, sort modes), article read. |
| Documents | doc-serving routes (see `wiki_routes.py` / `dependencies.py` for path resolution) | `/doc/*` content reads for `wiki/*` and `raw/*` paths, backlinks, archived/superseded metadata. Content comes from vault storage (R2/local) via a TS port of the `Storage` read surface (`core/storage.py`, read ops only). |
| Sources | source listing routes | list/search/facets, pagination. |
| Sessions | `app/api/session_routes.py` | list, get/replay, `GET /sessions/{id}/markdown` export. |

**Out (explicitly):** query/stream + BTW (M3), ingest/staged uploads (M3), compile/jobs/SSE progress (M4), proposals, lint/explore, cost routes, any write path except auth's own token/api-key writes, any DDL. **Alembic remains the sole owner of the database schema until cutover — M1 ships zero migrations; `drizzle-kit generate` output is for parity review only, never applied.**

## Contract fidelity — the M1 invariant

The de-facto contract is **what the React app consumes**: the Zod schemas and fetch calls in `web/src/api/*.ts` (auth/refresh flow in `client.ts`), plus the FastAPI response models in `app/api/schemas/`. `API.md` is directionally useful but stale (pre-May-4 features) — code wins.

Task 1 of M1 is a **contract inventory**: enumerate every in-scope endpoint from the Python routers — method, path, params, request/response shape, status codes, auth requirement, pagination envelope — as a checked-in doc (`docs/api-contract-m1.md`). Implement against that inventory; check items off as parity tests pass.

**Parity harness (required, part of M1, seeds the M2 characterization harness):** a script that seeds a scratch Postgres (alembic head + fixture data covering: multi-vault user, wiki articles incl. archived/superseded, raw sources, sessions incl. multi-turn), runs the Python backend and the TS backend against the same DB, replays the inventory's requests against both, and diffs JSON responses (allowing an explicit, reviewed ignore-list, e.g. server timing headers). CI-runnable via `just`.

## House rules (rewrite spike code to these as touched)

- **Config:** all environment access through Effect `Config` (`Config.redacted` for secrets), validated where read, failing at layer construction — never `process.env` in application code, never throw-at-module-scope.
- **Errors:** typed Effect errors only for expected/recoverable domain cases callers handle (not-found, auth-denied, validation); everything else stays a defect. No fallbacks on internal typed values (`??`/`||` on things that must exist is a bug, not robustness).
- **Schemas:** Drizzle DSL is the only place tables are defined; row types via `$inferSelect`; runtime decode only at true parse boundaries (HTTP bodies, JSONB columns, external APIs) using `drizzle-orm/effect-schema`-derived or `satisfies`-pinned Effect Schemas. Naming follows the repo vocabulary: `Create*`/`Update*`/`*Overview`/`*Detail` — no new suffix inventions.
- **Layering:** HttpApi route handlers are thin — parse/authz/delegate; domain logic lives in `packages/server` services (or `packages/domain` for pure logic) with constructor-style Layer DI. No context-bag parameter objects. No lazy imports. Top-level imports only.
- **SQL:** through the Drizzle `effect-postgres` client; raw `sql` fragments where Postgres features demand it (tsvector queries, etc.) — mirrored from the Python repository layer's semantics, not reinvented.
- **Logging:** structured (JSON) with `event` names, `request_id`, `user_id`/`vault_id` where available — port the spirit of `core/telemetry.py`'s wide events; do not build a new framework in M1.
- **Comments/docs:** match the existing repo's density; docstrings describe role, not wire syntax.

## Task breakdown (suggested order)

1. Contract inventory (`docs/api-contract-m1.md`) + fixture/seed script + parity-harness skeleton
2. Step 0 toolchain work (mergeable independently)
3. Config/layer foundation: `Config` schema for all M1 settings (DB URL, JWT secret, Resend key, R2 credentials), PgClient layer, HttpApi skeleton with auth middleware (JWT + API-key), error→status mapping
4. Auth endpoints + cross-backend token verification test
5. Vaults + wiki + sources reads (DB-only paths) — parity green
6. Document content reads (R2/local storage read port) — parity green
7. Sessions reads + markdown export — parity green
8. CI wiring for the parity harness; M1 review pass (style conformance over all spike-era files touched)

## Acceptance criteria

1. Parity harness green: every inventoried endpoint returns identical JSON/status/headers-that-matter from both backends against the same seeded DB
2. React app fully functional for browse/read/login flows with `VITE_API_BASE` pointed at the TS server (manual smoke: login → home → wiki → article → sources → sessions → session replay → markdown export)
3. A JWT minted by either backend verifies on the other; refresh flow works cross-backend
4. `just ci` green on main, no `--no-verify`, packages typechecked + linted
5. Zero schema changes; zero Python behavior changes (Python side is read-only reference except a shared JWT secret/env if not already externalized)
6. All M1-touched TS files conform to house rules (no `process.env`, no internal fallbacks, thin routes)

## Process

- Work lands on `main` in reviewable increments (per parent plan invariant #1); the TS service is inert in prod until cutover (Render still deploys the Python service only)
- Commit style: describe code generically; no test-corpus specifics
- When something in the Python contract looks like a bug or accident, do not silently replicate *or* fix it — record it in the inventory doc under "contract oddities" for a human decision
