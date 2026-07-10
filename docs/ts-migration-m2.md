# M2 — API parity harness

**Parent plan:** `docs/ts-migration.md`. **Requirements spec:** `docs/api-contract-m1.md` (endpoints + Decisions 1–11 + Fixture requirements). M2 is the workstream that **gates cutover**: it proves, mechanically and repeatably, that the TS backend serves the same contract as the Python backend — with every deliberate divergence licensed by a recorded decision and everything else identical. (The compile-artifact/golden-compile half of the characterization harness lands later, alongside the M4 pipeline port.)

## Architecture

One scratch Postgres (alembic head) + one local storage root, shared by **both backends running simultaneously** on different ports: Python via uvicorn (`SUPPRESS_AUTH=true`, `STORAGE_BACKEND=local`, shared `DATA_DIR`/`DATABASE_URL`, dummy Resend), TS via the existing server (same env family). The harness is a TS package (`packages/parity`, dev-only, never shipped; wired into the workspace and typecheck but excluded from anything the server imports).

Two phases per run:

1. **Mutation flows** (auth lifecycle: request-code → verify-code → refresh → reuse-rejection → api-keys create/list/revoke → me-delete cascade): each flow runs **twice — once per backend, each against a freshly reset DB+storage state** — and the response *sequences* are compared step-by-step after normalization. Never run mutations against shared state.
2. **Read matrix**: seed once (DB rows via Drizzle + files on disk — implement the full Fixture requirements section of the contract doc, including archived+superseded articles, multi-role/multi-vault users, malformed/multi-meta session JSONL, missing markdown sidecar, registry-mismatch file, pagination boundary data), obtain a token **per backend** (verify-code under suppress-auth against the shared user set — no cross-backend token use), then replay the full request manifest against both and diff.

## Request manifest

A checked-in, declarative manifest (data file or typed TS module) derived from the contract inventory: every in-scope endpoint × the variant matrix (roles owner/editor/viewer/non-member/unauthenticated; JWT and API-key where applicable; pagination boundaries limit=0/cap/over-cap/offset-past-total; search/filter/facet variants; error paths — missing doc, invalid path, missing sidecar, malformed JSONL, registry mismatch). Coverage rule: every endpoint documented in `docs/api-contract-m1.md` appears in the manifest or in an explicit exclusion list with a reason.

## Diffing rules — the heart of it

- Compare status, JSON body (structural), and headers-that-matter (`content-type`).
- **Normalization** is path-scoped and explicit, never blanket: mask fields that are legitimately run-variant (tokens, server-minted uuids, `created_at`/`updated_at` where seeding can't pin them) at named JSON paths per endpoint. A masked path must be listed in the manifest entry; unlisted volatility = failure.
- **Expected divergences are encoded from the Decisions section, one rule per decision, referencing its number**: D1 (markdown missing sidecar: TS 404 vs Python 500), D3 (unknown-vault: TS 403 vs Python 404), D4 (`GET /wiki/{slug}`: Python 200, TS absent — manifest hits it and expects exactly that), D6 (422 body: flat string vs FastAPI array — shape-level rule scoped to 422s), D8/D9 (config semantics as recorded), D10 (`/links` on archive paths), D11 (session replay meta isolation on the multi-meta fixture; invalid session id TS 422 vs Python 404; non-object JSONL line TS skip vs Python 500). A divergence rule must match *exactly* (both sides' expected shapes) — a rule that stops matching is itself a failure, so decisions stay honest.
- Anything not normalized and not decision-licensed → **hard failure** with a readable per-request diff report (method, path, variant, both bodies, the diff).

## Deliverables

1. `packages/parity` with: environment orchestration (compose the scratch DB, run alembic via `uv run`, boot both backends, health-gate, teardown — reuse the `docker-compose.packages-test.yml` pattern on a distinct port/project), seed module, manifest, differ with normalization + divergence rules, and a report writer (console summary + a markdown report artifact with every diff).
2. `just parity` recipe — one command, hermetic, exit 0 only when all diffs are decision-licensed. NOT added to `ci`/`ci-full` (it needs the Python stack); add it to the `review` recipe chain and document it in `docs/ts-migration.md`'s M2 line as the cutover gate.
3. A short "How to read a parity failure" section appended to this document by the implementer, plus the initial full-green run's summary (endpoint count, request count, divergence-rule hits — each decision rule should be exercised ≥1 time; a decision rule with zero hits means the fixture for it is missing, which is a failure of the run).

## Rules

House rules from `docs/ts-migration-m1.md` apply to harness code (it's still code: Config-style env handling at the orchestration boundary is relaxed — process.env is acceptable in the launcher script only; no fallbacks on must-exist values anywhere). Python backend is run, never modified. Zero changes to `src/great_minds/`, `web/src/`, DDL, or `packages/{domain,server,database}` runtime behavior (adding exports needed by the seed module is fine). Exact pins; no new dependencies without justification (a JSON-diff lib is acceptable if vendoring ~100 lines is worse). The Python server needs its env supplied the same way the repo's own tooling does — check `src/great_minds/core/settings.py` for names; never print secrets.

## Acceptance

1. `just parity` green from a clean checkout (given docker + uv + pnpm), wall-clock under ~2 minutes
2. Every manifest entry exercised; every decision rule hit ≥1; zero unlicensed diffs
3. Deliberately breaking a TS response (e.g. rename one field locally) makes the run fail with a readable report naming the endpoint and diff — demonstrate this in the final report, then revert

## How to read a parity failure

Run `just parity`, then open `packages/parity/reports/latest.md`. The console summary is intentionally short; the markdown report is the source of detail.

Each failed request lists the method, path template, variant label, status/content-type/body diffs, and the Python and TypeScript values side by side. A request that matches a recorded decision is marked `PASS (D*)`; if that decision stops matching its exact expected Python/TS shapes, it becomes a failure rather than being silently normalized.

Fix unlicensed failures in the TS backend or fixture/manifest only after deciding which is wrong. Add a normalization only when the value is legitimately run-variant and the manifest can name the exact JSON path. Add or change a decision rule only when `docs/api-contract-m1.md` records the product decision behind the divergence.

## Initial green run

`just parity` completed green in 6.275s runner time. The run covered 24 contract endpoints with 75 requests: 13 mutation-flow requests and 62 read-matrix requests. Decision-rule hits: D1=1, D3=1, D4=1, D6=8, D8=2, D9=2, D10=1, D11=3. Endpoint exclusions: none.
