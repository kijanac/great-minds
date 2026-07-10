# TypeScript Migration Plan

**Status:** active. Decided 2026-07-08/09. This is the living plan for migrating the backend from Python/FastAPI to a TypeScript stack built on Effect. Supersedes nothing; the architecture it ports is described in `target_architecture.md`.

## Goal and non-goals

**Goal:** replace the Python backend (`src/great_minds/`) with a TypeScript backend, Effect end-to-end, behind the same HTTP contract and the same Postgres schema, with no user-visible behavior change at cutover.

**Non-goals (explicitly deferred):**

- Frontend rewrite (React 19 app stays; Svelte is a separate future decision)
- Local-first/desktop (concluded as exploration; see `archive/local-first-*` tags)
- Algorithm changes (canonicalize/registry-stability redesign happens **after** the port, in TypeScript)
- Multi-language operation (no mixed Python/TS worker fleets — one runtime serves at any time)

## Migration shape (invariants)

1. **Additive on main.** TS code lands in `packages/` on main behind the scenes; no long-lived divergent branch. The June 2026 attempt died of parallel-branch drift — never again.
2. **The database is the fixed point.** TS reads and writes the existing schema. Migrations remain reviewable SQL. Dogfooding data (vaults, sessions, sources, compile history) is never at risk from the runtime swap.
3. **Characterization harness before pipeline port.** Golden compiles on a fixed corpus. Deterministic artifacts (file/content hashes, cache keys, partition assignments, DB writes) must match Python exactly; LLM-dependent artifacts compared statistically. This harness is also the project's first real test suite.
4. **Single cutover, rollback kept warm.** Prod flips from the Python service to the TS service in one deploy once parity holds in staging. Python remains deployable until the TS side has survived real use, then is deleted.
5. **Feature discipline during the port.** Python-side product changes freeze or are consciously double-implemented; prefer freeze — the port should be aggressive and time-boxed, not leisurely.

## Target stack

Two candidate postures were evaluated. **Spike Zero arbitrated: posture A adopted (2026-07-09).** Evidence: `SPIKE_REPORT.md` on `spike/effect-v4-stack` (Rounds 1+2) — DB layer, StreamSse transport, live tool-calling loop, and single-process Postgres-only workflow durability (`ClusterWorkflowEngine.layer` + `SingleRunner.layer`) all passed on the pinned beta set. Known seam: v4 exposes no typed OpenRouter `cost` (Schema strips the wire field); per-call cost comes from a raw `GET /v1/generation?id=` lookup with retry (~25 lines, posture-agnostic). Posture B remains documented below as the fallback if the beta line degrades before GA.

| Layer             | Posture A — full modern (spike this first)                                                                                                                                 | Posture B — stable fallback                                                                         |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Effect            | v4 beta, pinned exact, batch upgrades between features                                                                                                                     | v3.21.x (feature-frozen line)                                                                       |
| HTTP              | HttpApi (`effect/unstable/httpapi`) with first-class `StreamSse`                                                                                                           | v3 HttpApi + hand-rolled SSE seam module (`HttpServerResponse.stream` + experimental `Sse` encoder) |
| DB runtime        | Drizzle v1 RC via official `drizzle-orm/effect-postgres`                                                                                                                   | Pure `@effect/sql-pg` (stable), raw tagged-template SQL                                             |
| DB schema/DDL     | Drizzle DSL + `drizzle-kit generate` (reviewable SQL)                                                                                                                      | Same (drizzle-orm 0.45 has no `effect` peer — kit is safe in both postures)                         |
| Row schemas       | Official `drizzle-orm/effect-schema` (no duplication)                                                                                                                      | `$inferSelect` types + `satisfies`-pinned Effect Schemas at parse boundaries only                   |
| LLM               | `@effect/ai` + `@effect/ai-openrouter` (v4 line)                                                                                                                           | Same, stable 0.x line (`@effect/ai@0.36`, `ai-openrouter@0.11`)                                     |
| Durable workflows | Effect workflow/cluster (in v4 core, unstable)                                                                                                                             | `@effect/workflow` + `@effect/cluster` (peer on stable v3)                                          |
| Runtime           | Node 24 LTS (both). Bun ruled out mid Zig→Rust rewrite                                                                                                                     | —                                                                                                   |
| TypeScript        | TS 7 (GA 2026-07-08), tsgo typecheck; `@effect/tsgo` (alpha) for editor DX                                                                                                 | Same                                                                                                |
| Monorepo          | `packages/{domain,server,database}` (+ existing `web/`), source-exports, no per-package builds, root project-references typecheck. Blueprint: lucas-barake/effect-monorepo | Same                                                                                                |
| R2                | `@aws-sdk/client-s3` + presigner                                                                                                                                           | Same                                                                                                |

Fixed in both postures: Node 24, TS 7, monorepo shape, Drizzle DSL for DDL, pnpm, one repo, one deploy.

**Known risk, posture A:** two pre-release cadences coupled at `drizzle-orm/effect-postgres` ↔ `effect/unstable/sql`. An Effect beta can break the integration until Drizzle rebases (has happened). Mitigation: exact pins, coordinated batch upgrades, never mid-feature.

**Known risk, posture B:** three seam modules to hand-maintain (SSE framing, schema pinning, platform imports), plus a scheduled v4 migration (rename-heavy, Schema rewritten) after the port. Official rename maps exist; no codemod yet.

## Spike Zero — the arbiter

One thin vertical slice through every risky layer, on posture A pins, time-boxed. Short-lived branch (`spike/effect-v4-stack`); merged if adopted, harvested if not. Either outcome keeps the monorepo scaffold, Drizzle table definitions, and domain code — only integration modules differ between postures.

**Scope:**

1. pnpm monorepo scaffold: `packages/{domain,server,database}` wired into the existing workspace, source-exports, root typecheck via tsgo
2. HttpApi service on Node 24: email-code auth shape (request-code/verify stubs, JWT issue/verify) + one authenticated JSON route
3. One `StreamSse` endpoint streaming a real OpenRouter tool-calling loop via `@effect/ai-openrouter`: ≥1 tool round-trip, token deltas to the client, typed usage/cost extracted from the finish part
4. Drizzle: table definitions mirroring 2–3 real tables incl. `search_index` (vector + tsvector columns); `drizzle-kit generate` produces sane SQL against a **throwaway local Postgres** (docker, alembic head applied); one `effect-postgres` query executing pgvector cosine ANN; one `effect-schema`-derived row decode
5. One durable workflow with a checkpointed step, running **single-node** (ShardManager + Runner colocated or equivalent) — survives a process kill/restart mid-workflow

**Pass criteria (all must hold):**

- SSE streams tokens incrementally through the Node adapter (no buffering), client disconnect interrupts the server fiber
- Tool-calling loop completes with typed parts; OpenRouter `cost` lands as a typed field
- pgvector ANN query returns correct neighbors against alembic-created tables; generated DDL is reviewable and correct for vector/tsvector/partial-unique
- Workflow resumes from checkpoint after process kill, single-node topology, no extra infra beyond Postgres
- The pinned beta set installs and typechecks cleanly under TS 7/tsgo; total scaffold-to-green under the time box without fighting >2 upstream bugs

**Fail → posture B:** swap integration modules (SSE seam, `@effect/sql-pg` queries, satisfies-pinned schemas, v3 workflow packages); everything else carries over.

## After the spike

1. **M1 — skeleton + auth + read paths** (detailed brief: `docs/ts-migration-m1.md`): vaults, wiki, sources, sessions read APIs behind the existing HTTP contract; React app pointable at either backend via env
2. **M2 — API parity harness** (brief: `docs/ts-migration-m2.md`; gates cutover, not M1 merges): `packages/parity` runs the Python and TS APIs against one seeded DB/storage root, diffs every M1 auth/read endpoint with decision-licensed divergences, and is wired as `just parity` in the `review` chain. Golden compile/artifact comparators land later with M4.
3. **M3 — ingest + query/session write paths — complete.** Ported the ingest surface, agentic `@effect/ai` query loop, and session writes with parity coverage and 18 recorded contract decisions.
4. **M4 — compile pipeline** phase-by-phase against the harness; durable workflows replace Absurd tasks
5. **M5 — staging parity, cutover, Python removal**
6. **Then:** canonicalize/registry-stability redesign (see `docs/compile_registry_probe_findings.md` and `docs/idea-ledger.md` § pipeline), in TypeScript, with tests

## Decision triggers

- **Drizzle 1.0 GA + Effect 4.0 GA** (if on posture B): revisit immediately — that milestone replaces all three seam modules with official equivalents
- **Absurd fallback:** if Effect workflow/cluster fails Spike Zero's topology test in both postures' variants, use `absurd-sdk` (TS, same Postgres schema already in prod) despite its experimental label; DBOS Transact is the second fallback
- Evidence base: three research memos (durable workflows, DB layer, platform/AI/tsgo), 2026-07-08, versions verified against npm registry/GitHub source at that date
