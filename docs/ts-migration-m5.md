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

## M5.1 — Results (2026-07-18) — COMPLETE

**Go/no-go: rehearsal passed.** The browser smoke was skipped as redundant — M4.5 already drove the unmodified frontend end-to-end, and the M5.1 read-parity sweep exercised every frontend-facing read endpoint against the real corpus more rigorously than a click-through. One open decision gates the cutover: the canonicalize token-limit wall (see below) fails the next full re-canonicalization on either backend until an output-budget bump or compile-v2 lands.


**Read-parity sweep: PASSED** — 980 requests over 27 endpoints against the full production copy (8,317 sources, 561 topics, 63k ideas, 197k chunks); every projection byte-equal at millisecond timestamp precision; D4 the only licensed divergence hit.

**Warm-cache compile: proven to the strongest reachable bar.** All extract (8,421), partition, and synthesize (994) cache keys constructed by TS byte-match the rows Python wrote. The `canonicalize_registry` miss is legitimate, not a port defect: the 2026-07-03 hardening changed the registry prompt and model after production's last compile (2026-07-02), so the cache is stale for current code on BOTH backends — verified empirically by running Python against the same copy with a dead LLM endpoint: identical phase, step, and failure semantics.

**Live compile on the staging copy (authorized): surfaced a pre-existing product wall.** With a real key, registry reduce and assignment completed, but validate's collision-cleanup call overflowed the model output limit — `output hit the token limit (finish_reason=length)` — the hardening's loud-truncation behavior, identical on either backend. Consequence: **production's next full re-canonicalization will fail the same way regardless of cutover** (before the hardening it would have silently corrupted the registry instead). This is the primary concrete motivation for compile-v2 and pushes its priority. Interim mitigation candidates (post-cutover): raise the reduce/cleanup output budget, or chunk the cleanup call.

**Staged-ingest R2 smoke: PASSED** after fixes — presign to the staging bucket, PUT, process, conversion, document persisted, one intent queued, `source_ingest` completed clean.

**Findings fixed during the rehearsal** (commits `11c094e`, `1a27e5f`): pipeline errors can no longer persist as the literal "undefined" (Effect TimeoutError message-less shape; formatter covers all cause shapes; terminal failures now logged structurally); zombie recovery matches journal entries by task type and identity; the warm-cache tool detects a legacy Absurd claimant immediately.

**Recorded live bugs:** Python #7 — the sources listing has no ordering tie-breaker; with bulk-ingested data (8,316 docs, two distinct `updated_at` values) paginated walks silently drop ~25% of documents and duplicate others, on both backends (one-line `file_path` tie-breaker, post-cutover). Cost rows flush only after publish, so failed compiles record no spend (Python-faithful; punch list).

**Rehearsal environment rules learned:** exactly ONE dispatcher may run against the staging copy — booting the Python API (for bearer minting) alongside the TS server races two reconcilers over one intent queue and parks compiles in a workerless Absurd queue; mint bearers from the TS server instead. Secrets ride process env only, never `env K=V` argv (visible in ps).

## M5.2 — Cutover (execution checklist)

1. Quiesce: confirm no in-flight Absurd tasks; drain per decision M4.2-8 (terminal-state all tasks, one final Python reconciler pass so intents receive `satisfied_at`; abandoned intents re-emitted post-cutover).
2. Final prod DB snapshot (rollback artifact).
3. Merge the render.yaml swap → push → Render deploys TS on the same api URL; suspend the worker service.
4. Verify: `/health`, schema-head assertion in logs, `determinism_pins_active` NOT in logs, login (existing session expected to survive — the JWT secret is preserved by Render's generateValue semantics), wiki reads, one query, one small ingest → reconciler dispatches → compile completes → cost row.
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
- **D2 JWT secret:** originally "rotate"; corrected 2026-07-15 — Render's `generateValue` only generates when the var doesn't exist, so a blueprint sync on the existing service PRESERVES the current secret. Since TS verifies the same HS256 `{sub, type}` shape Python issues, live sessions survive the swap. No re-login is expected; do not read its absence as a failure signal.
- **D3 Staging = local backends over a staged copy of prod data** (pg_dump + R2 prefix copy); no paid staging services.
- **D4 drizzle-kit owns the schema after Python removal;** alembic freezes at its final revision, asserted at boot.

## M5.1 runbook

All commands below operate on local staging copies. Keep credentials in environment variables or
CLI profiles; do not paste them into shell history, logs, or this document. The production database
and `gm-prod-*` buckets are read-only sources for the copy commands.

### 0. Prechecks

- The staging Postgres must be PostgreSQL 18 with the pgvector extension available, or `pg_restore` fails on the dumped `CREATE EXTENSION`.
- After the restore, confirm no unsatisfied compile intents remain — the Python lane's lifespan reconciler is LIVE during the sweep and would claim them mid-run, mutating the staged copy between the two lanes' reads:

```bash
psql "$STAGING_DATABASE_URL" -At -c "select count(*) from compile_intents where satisfied_at is null"
# must print 0; if not, satisfy them manually before booting either backend:
# psql "$STAGING_DATABASE_URL" -c "update compile_intents set satisfied_at = now() where satisfied_at is null"
```

### 1. Copy production Postgres and R2

```bash
pg_dump --format=custom --no-owner --no-acl "$PROD_DATABASE_URL" --file /tmp/gm-prod-m5.dump
pg_restore --clean --if-exists --no-owner --no-acl --dbname "$STAGING_DATABASE_URL" /tmp/gm-prod-m5.dump
```

Repeat the R2 copy and check for each owner bucket. `<owner-suffix>` is the unchanged suffix after
the `gm-prod-` prefix. The staging bucket must already exist.

```bash
rclone copy "r2:gm-prod-<owner-suffix>" "r2:gm-staging-<owner-suffix>" --checksum --progress
rclone check "r2:gm-prod-<owner-suffix>" "r2:gm-staging-<owner-suffix>" --checksum
```

The bucket name is persisted on both users and vaults, so point the staged database copy at the
copied buckets. This update is only against `$STAGING_DATABASE_URL`.

```bash
psql "$STAGING_DATABASE_URL" -c "UPDATE users SET r2_bucket_name = regexp_replace(r2_bucket_name, '^gm-prod-', 'gm-staging-') WHERE r2_bucket_name LIKE 'gm-prod-%';"
psql "$STAGING_DATABASE_URL" -c "UPDATE vaults SET r2_bucket_name = regexp_replace(r2_bucket_name, '^gm-prod-', 'gm-staging-') WHERE r2_bucket_name LIKE 'gm-prod-%';"
```

Prepare a writable local sidecar directory. The R2 backend still uses this for proposal bodies and
`.compile/<vault-id>/log.md`; copy the corresponding production disk data here if it is part of the
rehearsal snapshot.

```bash
mkdir -p "$STAGING_DATA_DIR"
```

### 2. Boot both read lanes

Use one staging JWT secret for both processes and acquire `$STAGING_BEARER_TOKEN` through the normal
staging login flow. Both base URLs are server roots (no trailing `/v1`). These commands do not run
Alembic; the restored database must already report revision `0006`.

Python lane:

```bash
DATABASE_URL="$STAGING_DATABASE_URL" JWT_SECRET="$STAGING_JWT_SECRET" DATA_DIR="$STAGING_DATA_DIR" STORAGE_BACKEND=r2 R2_ACCOUNT_ID="$R2_ACCOUNT_ID" R2_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" R2_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" R2_BUCKET_PREFIX=gm-staging OPENROUTER_API_KEY="$OPENROUTER_API_KEY" OPENROUTER_API_BASE=https://openrouter.ai/api/v1 UV_CACHE_DIR=/tmp/gm-uv-cache uv run uvicorn great_minds.app.api.server:create_app --factory --host 127.0.0.1 --port 8911 --log-level warning
```

TypeScript read lane (HTTP app only; no reconciler loop):

```bash
DATABASE_URL="$STAGING_DATABASE_URL" JWT_SECRET="$STAGING_JWT_SECRET" DATA_DIR="$STAGING_DATA_DIR" STORAGE_BACKEND=r2 R2_ACCOUNT_ID="$R2_ACCOUNT_ID" R2_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" R2_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" R2_BUCKET_PREFIX=gm-staging OPENROUTER_API_KEY="$OPENROUTER_API_KEY" OPENROUTER_API_URL=https://openrouter.ai/api/v1 HOST=127.0.0.1 PORT=8912 node --experimental-strip-types packages/parity/src/typescript-server.ts
```

### 3. Run the real-data read sweep

The runner issues only `GET` and `HEAD`; its request boundary throws before fetch for any other
method. IDs and paths are discovered from list responses rather than fixtures. For each jobs SSE
route it compares the initial snapshot event, then cancels both reads before heartbeat timing can
become part of the comparison.

```bash
STAGING_PYTHON_BASE_URL=http://127.0.0.1:8911 STAGING_TS_BASE_URL=http://127.0.0.1:8912 STAGING_BEARER_TOKEN="$STAGING_BEARER_TOKEN" pnpm --filter @great-minds/parity staging:parity
```

Stop both read lanes after the sweep. In particular, stop Python before the compile rehearsal so
only the TS reconciler can claim the new compile intent.

### 4. Run the warm-cache no-op compile

Choose a rendered vault and confirm its copied cache is non-empty. The runner repeats this check
through its read-only DB client before submission and verifies the count is unchanged afterward.

```bash
psql "$STAGING_DATABASE_URL" -c "SELECT count(*) FROM compile_cache_entries WHERE vault_id = '$STAGING_VAULT_ID'::uuid;"
```

Boot the production TS entrypoint alone. Port `1` is deliberately dead; keep the OpenRouter key
non-empty because `/compile` checks that the service is configured. Any attempted LLM request makes
the phase fail, so a completed run is the zero-traffic proof.

```bash
DATABASE_URL="$STAGING_DATABASE_URL" JWT_SECRET="$STAGING_JWT_SECRET" DATA_DIR="$STAGING_DATA_DIR" STORAGE_BACKEND=r2 R2_ACCOUNT_ID="$R2_ACCOUNT_ID" R2_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" R2_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" R2_BUCKET_PREFIX=gm-staging OPENROUTER_API_KEY=dead-port-proof OPENROUTER_API_URL=http://127.0.0.1:1 HOST=127.0.0.1 PORT=8912 node --experimental-strip-types packages/server/src/main.ts
```

The runner snapshots every rendered wiki document's API-visible `body_hash` and markdown, submits
the compile, polls the returned job to terminal, then checks the artifacts and cache-row count again.

```bash
DATABASE_URL="$STAGING_DATABASE_URL" STAGING_TS_BASE_URL=http://127.0.0.1:8912 STAGING_BEARER_TOKEN="$STAGING_BEARER_TOKEN" STAGING_VAULT_ID="$STAGING_VAULT_ID" pnpm --filter @great-minds/parity staging:warm-cache
```

The runner verifies that the new intent is owned by an Effect `Workflow/CompileTask` journal
request before waiting for phase progress. If the Python reconciler is still alive and claims it as
an Absurd task, the rehearsal fails immediately with the legacy task id instead of timing out.

### M5.0 Docker smoke commands

The smoke uses the package-test Postgres as a disposable database. Seed one user/vault/membership
and mint a bearer against `$SMOKE_JWT_SECRET` without printing it. The `docker run` environment names
are exactly the names in `docs/render.cutover.yaml`; R2 values may be inert smoke values because the
authenticated read below is DB-only.

```bash
docker compose -f docker-compose.packages-test.yml up -d --wait db
DATABASE_URL=postgresql://great_minds:great_minds@localhost:55434/gm_packages_test JWT_SECRET=packages-test-jwt-secret UV_CACHE_DIR=/tmp/gm-uv-cache uv run alembic upgrade head
psql postgresql://great_minds:great_minds@localhost:55434/gm_packages_test -c "INSERT INTO users (id,email,created_at) VALUES ('00000000-0000-4000-8000-000000005000','m5-smoke@example.invalid',now()); INSERT INTO vaults (id,name,owner_id,created_at) VALUES ('00000000-0000-4000-8000-000000005001','M5 Smoke','00000000-0000-4000-8000-000000005000',now()); INSERT INTO vault_memberships (id,vault_id,user_id,role,created_at) VALUES ('00000000-0000-4000-8000-000000005002','00000000-0000-4000-8000-000000005001','00000000-0000-4000-8000-000000005000','OWNER',now());"
SMOKE_JWT_SECRET=packages-test-jwt-secret
SMOKE_BEARER="$(JWT_SECRET="$SMOKE_JWT_SECRET" pnpm --dir packages/server exec node --input-type=module -e "import { SignJWT } from 'jose'; const now=Math.floor(Date.now()/1000); process.stdout.write(await new SignJWT({sub:'00000000-0000-4000-8000-000000005000',type:'access'}).setProtectedHeader({alg:'HS256',typ:'JWT'}).setIssuedAt(now).setExpirationTime(now+300).sign(new TextEncoder().encode(process.env.JWT_SECRET)));" )"
docker build --file Dockerfile.ts --tag great-minds-ts:m5 .
docker run --detach --name great-minds-ts-m5 --publish 18787:8787 --env DATABASE_URL=postgresql://great_minds:great_minds@host.docker.internal:55434/gm_packages_test --env JWT_SECRET="$SMOKE_JWT_SECRET" --env DATA_DIR=/data --env CORS_ORIGINS=http://127.0.0.1:5173 --env OPENROUTER_API_KEY=smoke-dead-port --env OPENROUTER_API_URL=http://127.0.0.1:1 --env STORAGE_BACKEND=r2 --env R2_ACCOUNT_ID=smoke --env R2_ACCESS_KEY_ID=smoke --env R2_SECRET_ACCESS_KEY=smoke --env R2_BUCKET_PREFIX=gm-smoke --env RESEND_API_KEY=smoke --env RESEND_FROM_EMAIL=smoke@example.invalid --env HOST=0.0.0.0 --env PORT=8787 great-minds-ts:m5
curl --fail --silent http://127.0.0.1:18787/health
curl --fail --silent --header "Authorization: Bearer $SMOKE_BEARER" http://127.0.0.1:18787/v1/vaults
docker inspect --format '{{json .State.Health}}' great-minds-ts-m5
docker rm --force great-minds-ts-m5
docker compose -f docker-compose.packages-test.yml down -v
```
