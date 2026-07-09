# M1 — TypeScript backend foundation: auth + read paths

**Parent plan:** `docs/ts-migration.md` (read it first — goal, invariants, adopted stack posture A). **Prerequisite evidence:** `SPIKE_REPORT.md` on branch `spike/effect-v4-stack`.

**Objective:** a TypeScript service (`packages/server`) that serves the existing auth flow and all read-only APIs for vaults, wiki, documents, sources, and sessions, such that the React app runs correctly against it by switching `VITE_API_BASE`.

**Design stance — no legacy, no compatibility machinery.** This is a clean implementation designed on its own terms in idiomatic TypeScript and Effect. The Python codebase is the *requirements* source (what the endpoints must do, what invariants hold), never the *design* source: do not transliterate its layer shapes, naming, or internal semantics, and do not add any cross-backend compatibility plumbing (no shared-token verification, no shims, no mirrored internals). The one external constraint is the wire contract the React app consumes — and even there, if the existing contract has a wart, flag it for a human decision rather than faithfully reproducing it (see Process).

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
| Auth | `app/api/auth_routes.py` | request-code (Resend email), verify-code, refresh, api-keys list/create/delete, me delete. JWT + refresh + API-key *behavior* (expiries, rotation, hashing) matches the documented requirements; token internals are the TS implementation's own — no cross-backend token compatibility. |
| Vaults | `app/api/vault_routes.py` | list/get, memberships, config read. Role checks (`owner`/`editor`/`viewer`) enforced identically. |
| Wiki | `app/api/wiki_routes.py` | article index (pagination, sort modes), article read. |
| Documents | doc-serving routes (see `wiki_routes.py` / `dependencies.py` for path resolution) | `/doc/*` content reads for `wiki/*` and `raw/*` paths, backlinks, archived/superseded metadata. Content comes from vault storage (R2/local) via a TS port of the `Storage` read surface (`core/storage.py`, read ops only). |
| Sources | source listing routes | list/search/facets, pagination. |
| Sessions | `app/api/session_routes.py` | list, get/replay, `GET /sessions/{id}/markdown` export. |

**Out (explicitly):** query/stream + BTW (M3), ingest/staged uploads (M3), compile/jobs/SSE progress (M4), proposals, lint/explore, cost routes, any write path except auth's own token/api-key writes, any DDL. **Alembic remains the sole owner of the database schema until cutover — M1 ships zero migrations; `drizzle-kit generate` output is for parity review only, never applied.**

## Contract and verification

The de-facto contract is **what the React app consumes**: the Zod schemas and fetch calls in `web/src/api/*.ts` (auth/refresh flow in `client.ts`), plus the FastAPI response models in `app/api/schemas/`. `API.md` is directionally useful but stale (pre-May-4 features) — code wins.

Task 1 of M1 is a **contract inventory**: enumerate every in-scope endpoint from the Python routers — method, path, params, request/response shape, status codes, auth requirement, pagination envelope — as a checked-in doc (`docs/api-contract-m1.md`), including a "contract oddities" section for anything that looks accidental. This inventory is the requirements spec.

**M1's own verification is a first-class test suite, not a compatibility check:** integration tests (vitest / Effect test tooling) running each endpoint against a seeded scratch Postgres (alembic head + fixtures covering: multi-vault user, wiki articles incl. archived/superseded, raw sources, sessions incl. multi-turn), asserting behavior from the inventory — plus unit tests where domain logic warrants them. CI-runnable via `just`.

**Cross-backend parity checking is a separate workstream** (the M2 characterization harness, which will diff both backends' API responses against one DB). It gates *cutover*, not M1 merges. Do not build it in M1 and do not shape M1 code around it.

## House rules (rewrite spike code to these as touched)

- **Config:** all environment access through Effect `Config` (`Config.redacted` for secrets), validated where read, failing at layer construction — never `process.env` in application code, never throw-at-module-scope.
- **Errors:** typed Effect errors only for expected/recoverable domain cases callers handle (not-found, auth-denied, validation); everything else stays a defect. No fallbacks on internal typed values (`??`/`||` on things that must exist is a bug, not robustness).
- **Schemas:** Drizzle DSL is the only place tables are defined; row types via `$inferSelect`; runtime decode only at true parse boundaries (HTTP bodies, JSONB columns, external APIs) using `drizzle-orm/effect-schema`-derived or `satisfies`-pinned Effect Schemas. Naming follows the repo vocabulary: `Create*`/`Update*`/`*Overview`/`*Detail` — no new suffix inventions.
- **Layering:** HttpApi route handlers are thin — parse/authz/delegate; domain logic lives in `packages/server` services (or `packages/domain` for pure logic) with constructor-style Layer DI. No context-bag parameter objects. No lazy imports. Top-level imports only.
- **SQL:** through the Drizzle `effect-postgres` client; raw `sql` fragments where Postgres features demand it (tsvector queries, etc.). Behavioral outcomes must match the inventory; the queries themselves are written fresh and idiomatically, not copied from SQLAlchemy.
- **Logging:** structured (JSON) with `event` names, `request_id`, `user_id`/`vault_id` where available — port the spirit of `core/telemetry.py`'s wide events; do not build a new framework in M1.
- **Comments/docs:** match the existing repo's density; docstrings describe role, not wire syntax.

## Task breakdown (suggested order)

1. Contract inventory (`docs/api-contract-m1.md`) + fixture/seed script
2. Step 0 toolchain work (mergeable independently)
3. Config/layer foundation: `Config` schema for all M1 settings (DB URL, JWT secret, Resend key, R2 credentials), PgClient layer, HttpApi skeleton with auth middleware (JWT + API-key), error→status mapping
4. Auth endpoints + integration tests
5. Vaults + wiki + sources reads (DB-only paths) + tests
6. Document content reads (R2/local storage read layer, designed fresh) + tests
7. Sessions reads + markdown export + tests
8. CI wiring for the test suite; M1 review pass (style conformance over all spike-era files touched)

## Acceptance criteria

1. Integration test suite green: every inventoried endpoint tested against the seeded scratch DB, behavior matching the inventory
2. React app fully functional for browse/read/login flows with `VITE_API_BASE` pointed at the TS server (manual smoke: login → home → wiki → article → sources → sessions → session replay → markdown export)
3. `just ci` green on main, no `--no-verify`, packages typechecked + linted + tested
4. Zero schema changes; zero Python code changes (it is a read-only reference)
5. All M1-touched TS files conform to house rules (no `process.env`, no internal fallbacks, thin routes); code reads as if the TS backend were the only one that ever existed

## Process

- Work lands on `main` in reviewable increments (per parent plan invariant #1); the TS service is inert in prod until cutover (Render still deploys the Python service only)
- Commit style: describe code generically; no test-corpus specifics
- When something in the Python contract looks like a bug or accident, do not silently replicate *or* fix it — record it in the inventory doc under "contract oddities" for a human decision
