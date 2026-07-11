# M4 API contract inventory — compile pipeline, workers, and durable workflows

Built the same way as `docs/api-contract-m1.md` and `docs/api-contract-m3.md`: Python routers/services are the requirements source, not the design source, cross-checked against `web/src/api/*.ts` + `web/src/hooks/*.ts` Zod schemas and callers. Continues M1/M3's endpoint-table format; does not repeat anything already covered (`/jobs/url` — ported in M3, excluded here per the task).

**PART 1** covers the remaining HTTP surface: `compile_routes.py`, `job_routes.py` (list/read + the job-progress SSE stream), `lint_routes.py`, `cost_routes.py`.

**PART 2** (the bigger half) covers pipeline behavior: per-phase inputs/outputs/DB writes/storage artifacts, content-hash cache keys (exact reproduction requirement for the TS port), progress-step emissions, LLM calls, determinism classification, plus workers/reconciler/pipeline_runs infrastructure.

---

# PART 1 — Remaining HTTP surface

## Mount reality (delta from M1/M3)

All four routers confirmed current as of `src/great_minds/app/api/v1/__init__.py:20-42`:

- `cost_router` — non-vault-scoped, mounted directly under `/v1` (`v1/__init__.py:24`) → `/v1/costs`.
- `vault_cost_router`, `compile_router`, `lint_router`, `job_router` — all under `vault_scoped` (`prefix="/vaults/{vault_id}"`, `Depends(require_vault_member)` applied once at that level, `v1/__init__.py:29-39`) → `/v1/vaults/{vault_id}/costs`, `/v1/vaults/{vault_id}/compile`, `/v1/vaults/{vault_id}/lint`, `/v1/vaults/{vault_id}/jobs`.
- Both `cost_routes.py` routers (`router` and `vault_router`) share the literal prefix `/costs` (`cost_routes.py:12-13`) — matches M1/M3's description exactly, no drift.

---

## `compile_routes.py` (`/compile`)

Module docstring (`compile_routes.py:1-6`) states the architecture directly: POST writes an internal `CompileIntent` attached to a job and returns the user-visible job; the compile-intents reconciler dispatches to Absurd within ~5s. `CompileIntent` is an internal outbox detail never exposed on the wire.

### POST `/compile` — request a manual compile

| | |
|---|---|
| Auth | vault member (inherited) + `LlmGuard` (`compile_routes.py:28`) — plain `503` `{"detail": "LLM service not configured (OPENROUTER_API_KEY missing)"}` (`dependencies.py:329-335`) if `OPENROUTER_API_KEY` unset, resolved before the handler body runs, same guard shape as M3's `/query` route. |
| Body | `CompileRequest` (`app/api/schemas/tasks.py:8-11`) = `{job_id: uuid}` — client-minted, *usually* doubles as the `pipeline_runs` PK (matches `/jobs/url`'s pattern from M3) — **but not unconditionally**: `request_compile` (`compile_intents/service.py:29-45`) first calls `ensure_pending`, and if a pending intent for this vault already exists with a `pipeline_run_id` already attached, that existing run's id is returned and the client-minted `job_id` is silently discarded — no new row is created, no error surfaced. Only when no pending intent exists yet (or the existing one has no run attached) does `job_id` become the new run's PK. |
| Response | `202 Accepted`, `JobResponse` (`app/api/schemas/jobs.py:15-40`, shape documented below under `GET /jobs/{job_id}`). |
| Behavior | Calls `CompileIntentServiceDep.request_compile(vault_id, job_id)` (`compile_routes.py:30`), which creates the `pipeline_runs` row + `compile_intents` row (see PART 2's `compile_intents`/reconciler section). |
| Errors | `RuntimeError` (uncaught → bare `500`) if `request_compile` returns `None`, i.e. "compile pipeline run missing for vault {vault_id}, job {req.job_id}" (`compile_routes.py:31-34`) — an invariant-failure assertion, not a typed HTTP error; same pattern as M1's oddity #14 (registry-mismatch 500). |

### POST `/compile/{run_id}/cancel` — cancel a running compile

| | |
|---|---|
| Auth | vault member (inherited) — no additional guard, no `LlmGuard` (cancellation itself makes no LLM call). |
| Path | `run_id: uuid` |
| Response | `204 No Content` |
| Behavior | `PipelineRunServiceDep.cancel(run_id, vault_id)` (`compile_routes.py:46`). **Explicitly idempotent per the inline comment** (`compile_routes.py:44-45`): cancelling an already-finished run is a no-op — the route returns `204` either way; the UI is expected to learn the actual outcome from the job's SSE stream, not from this response. No `404` if `run_id` doesn't exist or belongs to another vault — **confirmed true no-op**: `PipelineRunRepository.cancel`'s `UPDATE` is conditioned on `WHERE id = :run_id AND vault_id = :vault_id AND status IN ('pending','running')` (`repository.py:165-169`), so a foreign-vault or nonexistent `run_id` simply matches zero rows and the route still returns `204`. |

M3's exclusion note said `POST /compile/{run_id}/cancel → 204` — confirmed current, unchanged.

---

## `job_routes.py` (`/jobs`)

`POST /jobs/url` is **out of scope for this document** — already fully inventoried in `docs/api-contract-m3.md` (`## Explicitly out of M3 scope` exception clause + the "URL ingest via `POST /jobs/url`" fixture entry). Confirmed still present unchanged at `job_routes.py:28-50`.

### GET `/jobs` — list

| | |
|---|---|
| Auth | vault member (inherited) |
| Query | `PageParamsQuery` (`limit`/`offset`, shared envelope) + `status: PipelineRunFilter \| null` — `PipelineRunFilter` (`core/pipeline_runs/schemas.py:18-31`) is a `StrEnum` mirroring `PipelineRunStatus` (`pending`/`running`/`completed`/`failed`/`cancelled`) **plus a synthetic `active`** value meaning `PENDING \| RUNNING` — an out-of-set `status=` value is a `422` at the boundary (closed set), not a silently-empty page (per the enum's own docstring, `schemas.py:21-24`). |
| Response | `200`, `Page<JobResponse>` (`job_routes.py:59-66`, standard `{items, pagination}` envelope). |
| Frontend | `web/src/api/jobs.ts::listJobs` — its `status` param type is narrowed to the literal `"active"` only (`jobs.ts:38`), i.e. the frontend never actually sends `pending`/`running`/etc. individually even though the backend enum supports them — a narrower client than the contract allows, not a bug. |

### GET `/jobs/{job_id}` — read one

| | |
|---|---|
| Auth | vault member (inherited) |
| Path | `job_id: uuid` |
| Response | `200`, `JobResponse` |
| Errors | `404` `{"detail": "Job not found"}` (`job_routes.py:76-77`) |
| `JobResponse` shape (`app/api/schemas/jobs.py:15-40`) | `{ id: uuid, vault_id: uuid, trigger: PipelineTrigger ("staged_files"\|"url"\|"manual"), status: PipelineRunStatus ("pending"\|"running"\|"completed"\|"failed"\|"cancelled"), current_phase: string (default ""), phase_status: string (default ""), progress_steps: PipelineProgressStep[], error: string\|null, created_at, updated_at, completed_at: datetime\|null, stream_url: string (computed field, always `f"/jobs/{id}/stream"`) }`. `PipelineProgressStep` (`core/pipeline_runs/schemas.py:71-77`) = `{key, label, status: PipelineStepStatus ("pending"\|"running"\|"completed"\|"failed"), done: int\|null, total: int\|null, detail: string (default "")}`. Docstring (`jobs.py:15-21`) explicitly notes Absurd task IDs and compile intents are implementation details **intentionally omitted** from this public shape. |
| Frontend Zod | `web/src/api/jobs.ts::jobSchema` / `progressStepSchema` — field-for-field match against the Pydantic shape above, including the same defaults-as-required-strings pattern (`current_phase`/`phase_status` are non-nullable strings on both sides, `error` nullable on both). No mismatch found (contrast M1's `precis` nullability oddity — this pair is clean). `stream_url` is present in Zod but **no frontend code was found reading `job.stream_url`** — see oddity #2 below. |

### GET `/jobs/{job_id}/stream` — see "THE JOB-PROGRESS SSE STREAM" section below for full protocol documentation (emit sites, LISTEN/NOTIFY wiring, reconnect-snapshot and `phase_status` semantics, termination). Route-level facts only, for completeness of this table: auth = vault member (inherited); `404` `{"detail": "Job not found"}` if the job doesn't exist for this vault (`job_routes.py:88-90`, checked once before the stream opens — a job that's deleted/never-existed never gets a stream at all, vs. a job that exists but the connection later drops mid-stream, which is the SSE section's concern).

---

## `lint_routes.py` (`/lint`)

Module docstring (`lint_routes.py:1-13`) is explicit about the design: detection-only, on-demand, no LLM calls, no writes, no file reads — a handful of indexed DB queries over tables that `verify` already populated at compile time. Frontend polls it via `useExploreBadge`; the Explore page surfaces findings as automatic notifications (no "run lint" button in the UI).

### GET `/lint`

| | |
|---|---|
| Auth | vault member (inherited) — no additional guard |
| Response | `200`, `LintReport` (`core/lint.py:45-48`) = `{ orphans: WikiArticleOverview[], dirty_topics: uuid[], unmentioned_links: UnmentionedLink[] }` |
| `WikiArticleOverview` | Reused verbatim from M1's `GET /wiki` shape (`file_path, title, precis, updated_at, slug`) — `doc_repo.list_orphans(vault_id)` (`lint.py:55`), rendered articles with zero incoming backlinks. |
| `dirty_topics` | List of raw topic UUIDs (not titles/slugs) whose `rendered_from_hash` drifts from the topic's current `compiled_from_hash` — i.e. compiled inputs shifted since the article was last rendered (`lint.py:56`, `topic_repo.list_dirty_topic_ids`). The frontend receives bare UUID strings with no accompanying title/label. |
| `UnmentionedLink` (`lint.py:37-41`) | `{source_slug, source_title, target_slug, target_title}` — a `topic_links` edge (reduce's intent) whose target article isn't actually cited in the source article's rendered prose; i.e. the intended edge has no matching `backlinks` row. Computed via a SQL anti-join (`_unmentioned_links`, `lint.py:61-71+`) between `topic_links` and `backlinks`, not by re-reading file content. |
| Explicitly NOT surfaced | Unresolved citations (prose links to a slug with no live topic) — per the docstring, `verify` already does that file walk at compile time and logs `unresolved_citation` events; re-deriving them here on demand would mean re-reading every article body from object storage, so it's deliberately excluded (`lint.py:23-25`). |
| Frontend | `web/src/api/explore.ts::fetchLintResults` → `lintResponseSchema` — field-for-field Zod match (`unmentionedLinkSchema` matches exactly; `dirty_topics: z.array(z.string())` correctly treats UUIDs as opaque strings). Consumed by `use-explore-badge.ts::useExploreBadge` (react-query, `enabled: !!vaultId`), rendered on `explore-page.tsx`/`explore-container.tsx`/`pages/explore.tsx`. Confirmed live, non-dead endpoint. |

M3's exclusion note listed only `GET /lint` for this router — confirmed, still the sole route, unchanged.

---

## `cost_routes.py` (`/costs`, both mounts)

### GET `/costs` (top-level, `/v1/costs`) — caller's own aggregate

| | |
|---|---|
| Auth | required (any authenticated user — `CurrentUser`, JWT or API key); **no vault-membership check at all**, consistent with its non-vault-scoped mount. |
| Query | `since: datetime \| null`, `until: datetime \| null` (both optional, no default range — omitting both aggregates all time). |
| Response | `200`, `CostAggregate` (`core/llm_costs/schemas.py:16-22`) = `{ total_usd: Decimal, event_count: int, by_vault: CostBreakdown[], by_event_type: CostBreakdown[] }`. |
| Behavior | `cost_service.aggregate(user_id=user.id, since=since, until=until)` (`cost_routes.py:24`) — aggregates **the caller's own** user-attributed `llm_cost_events` rows across every vault they've touched, not scoped to a single vault. |

### GET `/costs` (vault-scoped, `/v1/vaults/{vault_id}/costs`) — vault aggregate

| | |
|---|---|
| Auth | vault member (inherited) — **any role**, no `VaultOwnerGuard`/`VaultEditorGuard`; the docstring notes membership is enforced by the vault-scoped router, not restated at the route (`cost_routes.py:34-37`). |
| Query | Same `since`/`until` optional params. |
| Response | Same `CostAggregate` shape. |
| Behavior | `cost_service.aggregate(vault_id=vault_id, since=since, until=until)` (`cost_routes.py:38`) — **all** cost-bearing events for the vault, across every user, not scoped to the caller. |

**No `user_id` + `vault_id` combined-scope variant exists** — a caller cannot ask "my costs within this one vault" in a single request.

### Frontend cross-check — cost routes

**Zero callers found anywhere in `web/src`.** No cost-related API module, no fetch to `/costs` in any hook or component. Both `GET /costs` variants are fully implemented, reachable, real API surface — matching M1's `GET /wiki/{slug}` and M3's dead-endpoint precedent. The entire `cost_routes.py` surface is dead from the current web app.

---

## Part 1 oddities

1. **`cost_routes.py` is entirely dead from the frontend** — both `GET /costs` (user-scoped) and `GET /vaults/{vault_id}/costs` (vault-scoped) have zero callers in `web/src`. Fully implemented, real DB-backed aggregation, but no UI surface exists to display it. Candidate for either building the missing UI or explicitly deferring cost visibility — worth a human call before the TS port decides whether to carry this surface forward (cf. M1 decision 4, which dropped a similarly-dead route entirely).
2. **`JobResponse.stream_url` is a computed field with no confirmed frontend reader.** The response includes a server-computed `stream_url: f"/jobs/{id}/stream"` field, validated by the frontend Zod schema, but no caller was found actually reading `job.stream_url` — the stream path appears to be reconstructed independently wherever it's opened. If confirmed by the SSE section below, this is a redundant/vestigial field in the same family as M3's oddity #6 (`ExchangeData.btws`).
3. **`POST /compile/{run_id}/cancel` has no ownership/existence check at the route layer — confirmed true no-op cross-vault.** Unlike `GET /jobs/{job_id}`'s explicit `404` on a missing job, cancel's `204`-always contract (by design, per the inline "idempotent" comment) means a client cancelling a `run_id` that belongs to a different vault, or doesn't exist at all, gets the same success response as a real cancellation — `PipelineRunRepository.cancel`'s `WHERE id = :run_id AND vault_id = :vault_id AND status IN ('pending','running')` (`repository.py:165-169`) matches zero rows in either case, so the route returns `204` regardless.
4. **`POST /compile`'s only failure mode is an untyped `500`** (`RuntimeError` when `request_compile` returns `None`) — same "invariant assertion as bare 500" pattern M1 flagged (oddity #14) for the registry-mismatch case on `GET /doc/{path}`.
5. **`GET /lint`'s `dirty_topics` returns bare UUIDs with no title/label**, unlike `orphans` (full `WikiArticleOverview` with title) — a client wanting to show "Topic X is stale" needs a second round-trip or a client-side topic-id→title cache.

**Frontend cross-check summary**: `GET /jobs`, `GET /jobs/{job_id}`, `GET /jobs/{job_id}/stream`, `POST /jobs/url` (M3), `POST /compile`, `POST /compile/{run_id}/cancel`, and `GET /lint` are all live and called from `web/src`. The entire `cost_routes.py` router (both mounts) is dead — zero frontend callers.

---

## THE JOB-PROGRESS SSE STREAM — `GET /jobs/{job_id}/stream`

Full route: **`GET /v1/vaults/{vault_id}/jobs/{job_id}/stream`** — confirmed distinct from `/query`'s SSE (no shared code, per M3's correction note). Endpoint at `src/great_minds/app/api/job_routes.py:81-100`, generator at `job_routes.py:103-185`. Consumer: `web/src/hooks/use-job-sse.ts` (388 lines).

### Request

| | |
|---|---|
| Path | `GET /jobs/{job_id}/stream` (vault-scoped, `job_routes.py:81`) |
| Auth | vault member (router-level guard, inherited — no extra guard in the handler) |
| Pre-stream check | `pipeline_service.get(job_id, vault_id)` (`job_routes.py:88`) — plain `404` `{"detail": "Job not found"}` **before** the stream opens if the run doesn't exist for this vault. The one pre-flight JSON-error case, analogous to M3's `/query` 503-before-stream. |
| Headers | `Cache-Control: no-cache`, `Connection: keep-alive`, `X-Accel-Buffering: no` (`job_routes.py:95-99`) — note the extra explicit `Connection: keep-alive` that `/query`'s response doesn't set. |

### Response framing

Same two-line-plus-blank SSE framing as `/query`, but this stream additionally uses **bare `data:`-only frames** (no `event:` line → client-side default event type `"message"`) for the actual progress payloads, **explicit `event:` frames** only for `connected`/`done`, and **SSE comment lines** (`: heartbeat\n\n`) for keepalives — a three-frame-shape protocol, richer than `/query`'s uniform `event:`+`data:` pairing.

### Event types (exhaustive)

| frame | when | payload |
|---|---|---|
| `event: connected` | Always first, immediately on stream open (`job_routes.py:162`) | `{"id": "<job_id>"}` |
| *(bare `data:`, implicit `message`)* | Once immediately after `connected` with the current DB snapshot (`job_routes.py:164-166`), then again every time a matching NOTIFY wakes the loop (`job_routes.py:174-177`) | Snapshot shape below |
| `event: done` | Terminal — emitted right after a snapshot whose `job_status` is `completed`/`failed`/`cancelled` (`job_routes.py:167-169` on the initial snapshot, `178-180` in the loop) | `{"id": "<job_id>"}` |
| *(comment `: heartbeat`)* | Every 30s the notify queue is empty (`job_routes.py:181-182` — `asyncio.wait_for(queue.get(), timeout=30.0)` times out) | Not an event at all — an SSE comment line; the frontend's `parseSseBlock` explicitly skips lines starting with `:` (`use-job-sse.ts:155`), so heartbeats never reach `handleMessage`. Pure keepalive against proxy/idle timeouts. |

**Snapshot payload shape** (`_event_stream.snapshot()`, `job_routes.py:109-146`), read fresh from `pipeline_runs` on every emit — this is the entire SSE data contract, and it's the same row shape whether initial or NOTIFY-triggered:

```json
{
  "id": "<uuid>", "vault_id": "<uuid>", "trigger": "staged_files"|"url"|"manual",
  "job_status": "pending"|"running"|"completed"|"failed"|"cancelled",
  "phase": "upload"|"source_ingest"|"ingest"|"extract"|"abstract"|"derive"|"render"|"verify"|"publish"|"",
  "phase_status": "started"|"progress"|"completed"|"failed"|"",
  "steps": [ {"key": str, "label": str, "status": "pending"|"running"|"completed"|"failed", "done": int|null, "total": int|null, "detail": str}, ... ],
  "error": str,               // present only if row.error is truthy — key omitted entirely otherwise (job_routes.py:141)
  "updated_at": "<iso>"|null,
  "completed_at": "<iso>"|null
}
```

**No Zod / runtime validation on the frontend — a real divergence from `/query`.** `use-job-sse.ts:271`: `const raw: BackendPipelineEvent = JSON.parse(msg.data);` is a bare type **assertion**, not a parse. `BackendPipelineEvent` (`use-job-sse.ts:50-57`) only declares `{id, phase, phase_status, job_status?, steps, error?}` — `vault_id`, `trigger`, `updated_at`, `completed_at` are silently present-but-untyped/ignored. Unlike M3's `/query` stream (real `z.discriminatedUnion` per event), a TS port reproducing "the frontend's actual contract" has nothing structural to validate against except this loose interface — recommend the TS port write a real Zod schema for this payload and treat the shape above as the spec.

### `phase` → `PipelineStage` mapping and unknown-phase handling

`normalizeEvent` (`use-job-sse.ts:142-147`) maps the eight backend phase strings to eight UI stage names via `PHASE_TO_STAGE` (`use-job-sse.ts:69-78`): `source_ingest→uploading, ingest→indexing, extract→reading, abstract→synthesizing, derive→connecting, render→writing, verify→checking, publish→publishing`. **If `phase` doesn't match any key** (e.g. `"upload"` — a `PipelinePhase` member that exists at `core/pipeline_runs/schemas.py:41` but has no `PHASE_TO_STAGE` entry, or the empty-string default `current_phase=""` a freshly-created row has before its first progress emit) **`normalizeEvent` returns `null` and the event is silently dropped** (`use-job-sse.ts:145,272-273`) — UI state doesn't advance. See oddity #1.

### Ordering guarantees

Within a single stream lifetime: `connected` → snapshot(s) (zero or more) → `done` (terminal) — mirrors `/query`'s `token* done` shape but with DB-snapshot events instead of token deltas. Snapshots are **whole-state, not deltas** — every snapshot carries the complete current `progress_steps` array for the current phase; a client that misses N snapshots (heartbeat gap, brief disconnect) loses nothing because the next snapshot is fully self-describing.

Snapshots are **not** guaranteed for every phase in enum order. **Confirmed early-exit case** (`workers.py:539-553`): if `staged_file_ingest` finds `ingested == 0 and failed == 0` ("sources already up to date" — dedup by `body_hash` means nothing changed), it emits phase **directly** `phase="publish", status="completed"` — skipping `ingest`/`extract`/`abstract`/`derive`/`render`/`verify` in the SSE stream entirely. The frontend handles this because `applyEvent` (`use-job-sse.ts:170-206`) is index-based (`STAGES.findIndex`), marking every stage with `i < phaseIdx` complete regardless of whether an event was ever seen for it (`use-job-sse.ts:174-178`) — stage-skipping degrades gracefully, but a TS port's fixture set needs a "no-op recompile" case to exercise this jump.

### Snapshot-replay-on-reconnect semantics

There is **no dedicated "replay" event or endpoint** — reconnection just re-runs the same request/response cycle from scratch; durability comes entirely from the snapshot always reading current DB state rather than replaying a log:

- Backend: every new SSE connection (`_event_stream`) independently opens a fresh `asyncpg` connection, registers a fresh `LISTEN`, and immediately computes and yields a fresh `snapshot()` (`job_routes.py:164-166`) **before** waiting on any NOTIFY — a reconnecting client almost always gets the row's current state as its very first `data:` frame, with no gap or replay-log needed. **This initial snapshot is conditional, not unconditional**: `job_routes.py:164-166` is `initial = await snapshot(); if initial is not None: yield ...` — `snapshot()` returns `None` if the row can't be found by `(id, vault_id)` at that exact instant. Since the route already did a `pipeline_service.get(job_id, vault_id)` 404-check moments earlier (`job_routes.py:88`), a `None` here would only occur on an extremely narrow row-deleted-mid-request race (no deletion path for `pipeline_runs` rows was found — see unknowns); when it happens, no `data:` frame is emitted at all and the stream falls straight through to the NOTIFY-wait loop. If the run is already terminal, the fresh connection immediately emits that one snapshot then `done` and returns (`job_routes.py:167-169`) — reconnecting to a finished job is a one-shot snapshot-then-close, not a hang.
- Frontend: `useJobSSE`'s `run()` loop (`use-job-sse.ts:314-372`) is a `while (!cancelled && !terminal && !aborted)` retry loop with exponential backoff (`1000 * 2**attempt`, capped 10s, `use-job-sse.ts:251`) around the fetch-stream. On any thrown reader error (including Safari's `"Load failed"` on interrupted fetch/SSE, explicitly commented at `use-job-sse.ts:357-360`), it does **not** treat this as a job failure — no `setOverallError` in the `catch` — it just logs a warning and loops back to retry the fetch, which triggers the backend's snapshot-first-on-connect behavior. This is the literal mechanism behind the napkin note "pipeline state is durable and reconnect snapshots replay current state": there's no explicit replay protocol, just "GET a fresh snapshot every reconnect, because the row is the log."
- Nuance: **`attempt` (backoff counter) resets to 0 on "connection established"** (`use-job-sse.ts:335`, right after `res.ok`/`res.body` checks pass) — repeated *establishment* failures back off exponentially, but a stream that connects then drops mid-read retries near-immediately (next attempt starts at 1s). See oddity #6.

### `phase_status` semantics — proof it gates on `completed`, not `done>=total`

`PipelinePhaseStatus` enum (`core/pipeline_runs/schemas.py:57-61`): `started | progress | completed | failed`. This is a **phase-level** status distinct from the per-step `done`/`total` counters inside `steps[]` (whose own status is the separate `PipelineStepStatus` enum: `pending|running|completed|failed`, `schemas.py:64-68`).

Frontend proof, `applyEvent` (`use-job-sse.ts:180-181`):
```ts
const isComplete = event.phase_status === "completed";
const isFailed = event.phase_status === "failed";
```
— the phase's own `complete`/`active` UI flags are driven **exclusively** by the string `phase_status`, never by comparing any step's `done`/`total`. The `done`/`total` numbers (`use-job-sse.ts:183-184`, sourced from the currently-`running` step within `steps[]`) are used **only** for the progress-bar fill/label text (`"{label} {done} of {total}…"`, `use-job-sse.ts:198-199`) — cosmetic, never for gating phase advancement. This directly confirms the recorded invariant: extract's `embed_ideas` step can show `done === total` (all cards embedded) while `phase_status` is still `"progress"` (persistence/indexing not yet committed), and the UI correctly keeps the phase `active` until a later emit flips `phase_status` to `"completed"`.

Backend side of the same contract, `pipeline_runs/repository.py::update_progress` (`repository.py:181-219`): the **run-level** `status` column transition is itself derived from `phase_status`, not step counts — `FAILED` phase_status → run status `FAILED`; `phase == PUBLISH and phase_status == COMPLETED` → run status `COMPLETED`; anything else → run status `RUNNING` (`repository.py:197-211`). The pipeline's terminal `done`/`failed` classification (which is what flips the SSE stream to `event: done`) chains transitively from `phase_status`, never from any `done`/`total` pair — the invariant holds at both layers.

### Termination semantics

Three terminal `job_status` values, all producing `event: done` then generator return: `completed` (only reachable via `publish` phase's `phase_status=completed`, per the repository logic above), `failed` (any phase's `phase_status=FAILED` → run `FAILED` at `repository.py:197-201`, or the standalone `PipelineRunRepository.fail()` used by `PipelineProgressRunner.fail()` for out-of-band failures like uncaught exceptions, `pipeline_runs/service.py:153-161`), `cancelled` (below). After `event: done`, the generator's `finally` (`job_routes.py:183-185`) always runs — `conn.remove_listener` then `conn.close()`.

**There is no error event type at all** — unlike `/query`'s dedicated `error` event. A failed pipeline is communicated as an ordinary snapshot `data:` frame carrying `phase_status: "failed"` and an `error` string field, immediately followed by the generic `event: done` — the frontend's failure detection is entirely payload-content-based (`data.phase_status === "failed" || data.job_status === "failed"`, `use-job-sse.ts:283`), not frame-type-based.

**Cancellation** (`POST /compile/{run_id}/cancel` → `PipelineRunService.cancel`, `pipeline_runs/service.py:74-82`): a race-free conditional UPDATE (`WHERE status IN (active)`) sets `status=CANCELLED` **and `phase_status=FAILED`** (not a distinct cancelled phase_status — `repository.py:170-173`), commits (triggering NOTIFY), *then* cooperatively cancels the underlying Absurd task — the comment at `pipeline_runs/service.py:75-76` documents this ordering explicitly: "Commit the cancelled status (NOTIFY → UI) before the cooperative task cancel, which lands at the task's next step boundary." The SSE client can observe `job_status: "cancelled"` **before** the backend task has actually stopped (it stops at its next checkpoint). The frontend must check `job_status === "cancelled"` **before** the failed branch, and it does — `use-job-sse.ts:275` precedes the failed-check at line 283 — since `phase_status` is literally `"failed"` on a cancelled row too, checking failed first would misclassify every cancellation as an error. **This check ordering is load-bearing, not incidental** — flag for the TS port.

Cancelling an already-terminal run is an explicit no-op (`compile_routes.py:44-45`; the conditional `WHERE status IN (active)` matches no row, `repo.cancel` returns `None`) — `204` either way.

### LISTEN/NOTIFY wiring, end to end

Confirmed as **real Postgres LISTEN/NOTIFY**, not polling (the 30s heartbeat is a keepalive safety-net, not the wake mechanism):

1. **DB trigger** (`alembic/versions/0001_initial_schema.py:589-624`): `notify_pipeline_run_changed()` plpgsql function does `PERFORM pg_notify('pipeline_progress', json_build_object('pipeline_run_id', NEW.id, 'vault_id', NEW.vault_id)::text)`. Two triggers: `pipeline_runs_notify_insert` fires on every `AFTER INSERT`; `pipeline_runs_notify_update` fires `AFTER UPDATE` **only when** one of `status`/`current_phase`/`phase_status`/`progress_steps`/`error`/`completed_at` actually changed (`IS DISTINCT FROM` guard — no-op updates touching only `updated_at` don't fire it). Channel name constant mirrored in Python at `pipeline_runs/repository.py:23`: `CHANNEL = "pipeline_progress"`.
2. **Listener**: `job_routes.py::_event_stream` opens a **dedicated raw `asyncpg` connection** (`asyncpg.connect(dsn)`, `job_routes.py:106`) separate from the app's pooled SQLAlchemy session — DSN derived by stripping `"+asyncpg"` off `settings.database_url` (`job_routes.py:105`). Registers `conn.add_listener(CHANNEL, _on_notify)` (`job_routes.py:159`).
3. **Filter**: `_on_notify` (`job_routes.py:148-157`) parses the NOTIFY payload JSON and enqueues (`queue.put_nowait`) only if `pipeline_run_id`/`vault_id` match this stream's subscription — Postgres fans the same channel out to every listening connection, so **every open SSE connection for every job in the whole database receives every NOTIFY on this channel and filters client-side** (see oddity #3).
4. **Wake → re-read → push**: the NOTIFY payload carries only `{pipeline_run_id, vault_id}` — on match, the loop wakes from `queue.get()` and does a **fresh full row read** (`snapshot()`) rather than trusting the NOTIFY payload (`job_routes.py:171-177`) — NOTIFY is purely a wakeup signal; the DB row is always re-fetched as the data source, consistent with the migration comment "the DB row is the durable source of truth; this trigger emits a tiny 'go re-read this run' wakeup."

### SSE oddities

Numbered independently of the Part 1 list; folded into the document-level Contract oddities section at the end.

1. **A brand-new `PipelineRunRecord` (`current_phase=""`, `phase_status=""`) is unmappable by the frontend.** The INSERT trigger fires NOTIFY immediately on row creation (`0001_initial_schema.py:612-617`), before any phase is set. A client receiving this pre-first-progress-emit snapshot (`phase: ""`) gets `normalizeEvent → null` (`use-job-sse.ts:144-145`) and the event is silently dropped — no visible effect (UI stays in its initial `emptyStages()` state), but a real "the schema allows a phase value the client can't render" gap. Similarly, `PipelinePhase.UPLOAD = "upload"` (`schemas.py:41`) has no `PHASE_TO_STAGE` entry either — dead phase value from the frontend's perspective; **confirmed vestigial**, no write site for it anywhere in the codebase (superseded by the frontend's client-driven pre-SSE upload stage, `use-job-sse.ts:113-140`).
2. **No Zod/runtime schema validates the SSE payload on the frontend** — `JSON.parse(msg.data)` cast via bare TS annotation (`use-job-sse.ts:271`), unlike `/query`'s fully-Zod-validated events (M3). A malformed payload only fails loudly if `JSON.parse` itself throws (caught, silently ignored, `use-job-sse.ts:309-311`) — structurally-wrong-but-valid-JSON passes straight through untyped.
3. **Fan-out on a single shared NOTIFY channel.** All pipeline runs across the entire database share channel `"pipeline_progress"`; every open SSE connection filters client-side (`job_routes.py:152-154`). Harmless at small scale, O(listeners × notifies) under load — a TS port should consider a per-job channel name rather than literal parity.
4. **Cancellation sets `phase_status=FAILED`, not a distinct cancelled value** (`repository.py:170-173`) — `PipelinePhaseStatus` has no `CANCELLED` member; cancellation is distinguished only via top-level `job_status`, and the frontend's check ordering (cancelled before failed) is load-bearing but not obvious from the schema — a TS port that reordered these checks, or added a `cancelled` phase_status "for clarity," would need both sides updated in lockstep.
5. **Cancellation is observable via SSE before the underlying task has actually stopped** (intentional, `pipeline_runs/service.py:75-76`) — the UI shows "cancelled" while the Absurd task may still be mid-step until its next checkpoint. Not a bug, but a real eventual-consistency window worth a fixture.
6. **Reconnect backoff resets on "connection established," not on "clean disconnect."** A stream that connects then drops mid-read retries almost immediately (`attempt` reset at `use-job-sse.ts:335`); a stream that never opens backs off exponentially. Two failure modes, two retry cadences, no evident deliberate policy — human call on whether this is intentional.
7. **`/jobs/url`'s SSE stream is nearly moot** — `POST /jobs/url` runs its entire `source_ingest` phase synchronously in-request (M3), so by the time a client opens the stream the run is frequently already terminal; the stream's real job there is the one-shot snapshot-then-`done` path (`job_routes.py:167-169`), not live progress-watching.
8. **The `connected` event carries no snapshot data** (`{"id": ...}` only, `job_routes.py:162`) — purely a "stream is open" signal (`use-job-sse.ts:255-258` sets `connected=true` and returns), immediately followed by the real first snapshot as a second frame. A minor two-frames-for-one-fact pattern, not a bug.
9. **`POST /compile` has a dead duplicate client.** `web/src/api/compile.ts::compile()` and `web/src/api/jobs.ts::requestCompile()` both wrap the identical `POST /compile` call with a client-minted `crypto.randomUUID()` body and the same `jobSchema` parse. Only `requestCompile` (from `jobs.ts`) has a live caller (`pipeline-container.tsx:125`); `compile.ts::compile()` has zero callers anywhere in `web/src` — dead duplicate code, candidate for deletion rather than porting twice.

---

# PART 2 — Pipeline behavior inventory

Phase order as orchestrated (`pipeline/service.py:81-95`): ingest → extract → abstract (partition → **synthesize** → premerge → canonicalize → validate — note synthesize runs *between* partition and premerge, not after canonicalize; see the abstract section) → derive → render → verify → publish.

**Hashing primitive** (`core/hashing.py:24-67`) — all cache keys and content-identity hashes route through this module and must be reproduced **bit-exact** in TS: SHA-256 over length-prefix-framed parts — each part is UTF-8 encoded and prefixed with `struct.pack("I", len(bytes))` (4-byte unsigned int, **native byte order/size in Python's default struct mode** — little-endian 4-byte on every deployment target, but a TS port must pin 4-byte little-endian explicitly rather than inherit an assumption). `content_hash(*parts)` frames each part; `prompt_hash(template)` = framed `("prompt", template)`; `body_hash(body)` = framed `("body", body)`; `file_hash(content)` = framed `("file", content)`.

**Compile cache store** (`core/compile_cache/repository.py`): one Postgres table keyed `(vault_id, phase, cache_key)` with a JSONB `value`; `get` returns the value or `None`; `put` is `INSERT ... ON CONFLICT (vault_id, phase, cache_key) DO NOTHING` (`repository.py:29-41`) — first write wins, entries are never updated or invalidated in place; invalidation is purely by key drift (a new prompt/model/input hash produces a new key).

## Phase 0 — ingest (`src/great_minds/core/pipeline/ingest.py:1-101`)

**Inputs**: `SourceDocumentService.list_all(vault_id)` (`ingest.py:67`) reads all `source_documents` rows for the vault to build `stored_etags`/`id_by_path` maps — used to skip re-indexing unchanged R2 content. Storage: raw files under `raw/` walked inside `SearchService.rebuild_raw_index` (owned by `core/search`).

**Outputs**: No direct DB write in this file. Delegates to `SearchService.rebuild_raw_index(...)` (`ingest.py:71-79`), which upserts `search_index` chunk rows for raw docs — `rebuild_raw_index` takes the same `client: AsyncOpenAI` used for embedding. After indexing, `source_docs.refresh_etag_batch(...)` (`ingest.py:84-86`) updates `source_documents.etag` for every path whose ETag changed — batched `(id, etag)` pairs, silently skipping paths absent from `id_by_path` (unregistered docs excluded from the etag refresh, not an error).

**Content-hash cache keys**: **None.** No `compile_cache` import, no `content_hash` call. Docstring: "Purely mechanical — no LLM calls beyond the embedding model" (`ingest.py:1-10`). Skip logic uses ETag comparison, not cache keys.

**Progress steps**: `INGEST_STEP_LABELS = {"index_sources": "Indexing for search"}` (`ingest.py:25-27`) — single step; `progress` at start (`ingest.py:58-63`), `completed` at end (`ingest.py:93-101`), via `self.progress.emit(phase="ingest", ...)`. (Taxonomy drift vs. the recorded note — see the taxonomy cross-check below.)

**LLM calls**: None. Embedding-only (chunk embedding inside `rebuild_raw_index`; not a chat/completion call).

**Determinism**: chunk boundaries + ETag-skip logic **EXACT** given identical raw file bytes; the `search_index` embedding column **LLM-DEPENDENT** (embedding-model output, expected-stable but not bit-guaranteed).

**Embeddings**: yes — `rebuild_raw_index` embeds changed chunks via the passed `AsyncOpenAI` client (detail lives in `core/search`).

## Phase 1 — extract (`src/great_minds/core/pipeline/extract.py:1-682`)

**Inputs**: `SourceDocumentService.list_all(vault_id)` (`extract.py:101`) — the documents table is the authoritative registry; iterating it guarantees every ingested doc gets a shot at extraction (a DB row whose file is missing surfaces as a per-doc `file_not_found` failure via `storage.read(strict=False)`, not a silent skip, `extract.py:88-95,329-331`). Raw file content is read from storage **only on cache miss** (`extract.py:319-332` — the cache lookup happens before any storage read, so a full-cache-hit compile never touches `raw/` at all).

**Outputs**:
- `compile_cache` row per freshly-extracted doc (`phase="extract"`, `value={"source_card": ...}`, `extract.py:564-577`).
- `ideas` table rows via `IdeaService.record_extractions` per embedding batch (`extract.py:217-218`) — each row carries a 1024-dim embedding. Stale idea rows for cache-miss docs are bulk-deleted up front (`ideas.delete_for_documents`, `extract.py:215`), since fresh LLM output always mints new `uuid7` idea ids (`extract.py:537`), making prior rows for that doc orphans.
- On-disk frontmatter rewrite for every freshly-extracted doc (`_write_extract_frontmatter`, `extract.py:634-681`) — LLM-derived fields (`title`/`precis`/`author`/`date`/`genre`/`tags`) plus vault-configured `derived_extras` flattened to top-level frontmatter keys; body preserved byte-identical (anchors were already injected at ingest time).
- `source_documents` row mirror via `reindex_from_file` (`extract.py:242`) — "file is canonical for content-about-content; the DB row mirrors it" (inline comment).

**Cache key — exact, verbatim** (`extract.py:440-461`):
```python
def _cache_key(*, document_id: UUID, body_hash: str, prompt_hash: str) -> str:
    return content_hash(
        f"doc={document_id}",
        body_hash,
        f"prompt={prompt_hash}",
        f"model={EXTRACT_MODEL}",
    )
```
Deliberately **per-document, not per-body-content** — the docstring (`extract.py:440-455`) documents a real bug class this fixed: sharing one cache entry across two docs with identical bodies caused either a Postgres `CardinalityViolationError` (two extraction outcomes claiming the same cached idea_ids) or silent `title=NULL`-with-ideas corruption. Trade-off explicitly accepted: identical-content docs each pay a fresh LLM call — mitigated by ingest-time client-hash dedup making that rare. `prompt_hash` covers the whole-compile-constant rendered template (`_render_template_for_hash`, `extract.py:464-474` — `{kinds}`/`{vault_enriched_fields}` substituted once per compile, only `{doc_content}` varies per doc), so the key doesn't need to re-hash the full prompt text per document.

**Progress steps**: `extract_cards` ("Extracting source cards"), `embed_ideas` ("Embedding ideas") (`extract.py:53-56`) — exact match to the recorded taxonomy. `embed_ideas` progress is counted in **ideas**, not doc-batches, deliberately — "so the UI count matches the user's mental model ('embedding 1,350 of 7,200 ideas')" (`extract.py:196`).

**LLM call**: `EXTRACT_MODEL = "deepseek/deepseek-v3.2"` ("cheap, volume-heavy," `llm/providers.py:15,27`), `temperature=0.2`, one call per document. **Strict structured output** (`_extract_response_format`, `extract.py:367-437`) — a per-vault `json_schema` built from `VaultConfig.kinds`/`enriched_fields`, `"strict": True`/`"additionalProperties": False` throughout; `ideas` allowed empty (`minItems: 0`) so a content-light doc "succeeds-with-nothing" rather than erroring; `title`/`precis` always required so a doc can never come back identity-less (`extract.py:373-379`). Prompt: `load_prompt(storage, "extract")` (vault-override-then-default). Concurrency: `asyncio.Semaphore(settings.compile_enrich_concurrency)` (default 20).

**Per-document failure isolation** (`_extract_one`, `extract.py:302-364`) — **but only for the LLM-call stage, see oddity below**: `json.JSONDecodeError`, `ValidationError`, and any other exception each become an `_ExtractFailed(raw_path, error)` outcome; the phase continues over every other doc and completes with a partial result (`docs_failed` counted, `doc_failed` WARNING logged). Unknown `kind` values from the LLM are coerced to `"other"` rather than rejected (`_validate_extract_output`, `extract.py:509-544` — "a single odd kind shouldn't tank the whole doc"). Anchor localization (`_localize_anchors`, `extract.py:493-506`) matches quoted text to a paragraph index by substring match; an unmatchable quote (LLM paraphrased/normalized the source text) leaves `chunk_index=None` — a soft degradation (render still emits the footnote, just without a deep-link fragment), not a failure.

**Determinism**: `SourceCard`/idea content — **LLM-DEPENDENT**. `body_hash`/`prompt_hash`/cache-key construction, anchor-localization matching, frontmatter rewrite — **EXACT**.

**Embeddings**: yes — `_embed_in_batches` (`extract.py:586-626`) calls `client.embeddings.create(model=EMBEDDING_MODEL, ...)` **directly**, a second, independent embedding-call path from `core/search`'s own `embed_batch` helper (used by ingest/render). Texts = `f"{idea.label}. {idea.description}"` per idea, batched at `EMBEDDING_BATCH_SIZE=50` (a phase-local constant, `extract.py:51`, distinct from `core/search/service.py`'s own same-valued constant — see oddities), with a 300s per-batch timeout. **A timed-out batch is silently skipped, not retried and not failed** (`extract.py:602-613`) — those ideas are never embedded this compile; the gap self-heals only because the next compile's cache-hit path independently re-checks `existing_idea_ids` (`extract.py:176-177`) and re-embeds anything missing. LLM-DEPENDENT-but-deterministic-per-model; not itself cache-keyed via `compile_cache` — embeddings and the cached `SourceCard` text are two independently-recoverable layers, not one atomic unit.

## Phase 2 — abstract (`src/great_minds/core/pipeline/abstract/`)

### Orchestration (`abstract/__init__.py:1-267`)

**Fixed sequential order** (docstring + executed code, `__init__.py:1-16`, `88-267`): `partition.run()` → `synthesize.SynthesizePhase.run()` → `premerge.run()` → `canonicalize.CanonicalizePhase.run()` → `validate.ValidatePhase.run()`. **Synthesize runs between partition and premerge** — the docstring numbers them 2a partition, 2b synthesize, 2c premerge, 2d canonicalize, 2e validate. A "partition → premerge → canonicalize → synthesize" mental model (the directory-listing order) is wrong and is an easy porting mistake.

**Branching/skip logic**: exactly one short-circuit. If `partition.run()` returns an empty `chunks` list (vault has zero idea embeddings), the orchestrator logs `skipped reason=no_chunks`, emits a `status="completed"` progress frame with only `group_ideas` marked completed, and returns `[]` immediately (`__init__.py:124-135`) — the other four substeps never execute. No other conditional skips; premerge always runs, even trivially.

**State flow — return values only, no DB round-trip, no shared context object.** Each substep is instantiated fresh inside `run()` with explicit constructor dependencies (`__init__.py:63-86`) and receives prior-step output as a plain function argument: `partition → chunks: list[list[UUID]]`; `synthesize(vault_id, ideas, chunks) → local_topics: list[LocalTopic]`; `premerge(local_topics, jaccard_threshold=...) → merged_topics`; `canonicalize(vault_id, merged_topics) → canonical_topics`; `validate(vault_id, canonical_topics, merged_topics) → validated: list[TopicDetail]` (the phase's return). The module docstring states the design: "Returning composed results rather than mutating a bag keeps each sub-phase's contract explicit" (`__init__.py:11-15`) — a deliberate architecture the TS port should preserve (constructor DI + explicit return-value threading, not a context bag).

**Cache-phase names are substep-local**: `PHASE_REGISTRY`/`PHASE_ASSIGN` (canonicalize) and `PHASE = "partition"` are module-private constants; the orchestrator only passes the shared `CompileCacheRepository` down — each substep owns its cache namespace.

**Progress emission**: the whole abstract phase is one SSE `phase="abstract"` with five inner checklist steps, `ABSTRACT_STEP_LABELS` (`__init__.py:49-55`): `group_ideas: "Grouping ideas"`, `synthesize_topics: "Synthesizing topics"`, `merge_candidates: "Merging similar topics"`, `canonicalize_registry: "Organizing topics"`, `validate_registry: "Finalizing topics"`. The orchestrator emits the **full 5-step list** with per-key status before/between/after each substep (`__init__.py:90-266`). Partition gets fine-grained `done/total` via a `report_progress` callback wired into its k-means epoch loop (`_report_partition_progress`, `__init__.py:97-106`); synthesize self-reports per-chunk counts (it receives `self.progress`/`self.pipeline_run_id`/`progress_steps` directly); premerge/canonicalize/validate get only a single "now active" transition each.

### 2a — partition (`abstract/partition.py:1-419`)

**Classification**: mechanical/deterministic (docstring, `partition.py:1-12`) — "seeded k-means over all idea embeddings with a token-budget-driven k."

**Inputs**: `IdeaService.get_ids_for_vault(vault_id)` (narrow id-only read, deliberately cheap so a cache hit avoids loading embedding vectors — comment at `partition.py:68-69`); on cache miss: `IdeaService.iter_source_cards(vault_id)` for token-count estimates and `IdeaService.iter_overviews(vault_id, batch_size=1024)` streaming `EMBEDDING_DIMENSIONS`-dim vectors into a pre-allocated `(n, dims)` matrix (`partition.py:104-112`). **Consumes precomputed embeddings only — never calls an embedding model itself.** Settings: `compile_partition_target_tokens` (default `100_000`), `compile_partition_min_factor` (`0.3`), `compile_partition_max_factor` (`1.5`) (`settings.py:64-66`).

**Outputs**: no domain-table writes. One `compile_cache` row: `phase="partition"`, `value={"chunks": [[str(uuid),...]...], "k_initial": int, "total_tokens": int}` (`partition.py:128-137`). The `chunks` return value flows to synthesize purely in-memory (`abstract/schemas.py` docstring: pipeline-internal types "live between sub-phases in memory only — they never hit Postgres").

**Cache key — exact, verbatim** (`partition.py:415-419`):
```python
def _cache_key(id_order: list[UUID], target_tokens: int) -> str:
    return content_hash(
        *sorted(str(iid) for iid in id_order),
        f"target={target_tokens}",
    )
```
Every idea UUID in the vault, stringified then lexicographically sorted, followed by the literal `f"target={target_tokens}"`. Note `id_order` is *already* `sorted(...)` UUID objects at the call site (`partition.py:70,76`) and `_cache_key` re-sorts the stringified forms — the two sorts coincide for canonical lowercase-hyphenated UUIDs, but the TS port must replicate **string-sort-of-stringified-UUIDs**, verified bit-exact, not assumed.

**Algorithm** (for TS parity): `k = max(1, ceil(total_tokens / target))` clamped to `min(k, len(id_order))` (`partition.py:97-98`). Token estimate per idea: `chars(idea_line + doc_header + precis_line) // 4`, min 1 (`_estimate_idea_tokens`, `partition.py:180-200`) — a chars/4 heuristic explicitly coupled to how synthesize renders its prompt (`partition.py:9-11,191`). Clustering: `MiniBatchKMeans(n_clusters=k, random_state=42, n_init=1, batch_size=1024)`, manual `partial_fit` loop, max 10 epochs, early-stop on centroid shift `< 1e-3` (constants at `partition.py:32-38`); `k==1` short-circuits to all-zero labels (`partition.py:227-230`). Grouping via stable argsort-by-label + `np.split` (`_group_by_label`, `partition.py:275-287`). Rebalance: oversize chunks recursively split via 2-means (`random_state=42`; degenerate one-label case → deterministic even split, `_split_recursively`, `partition.py:318-339`); undersize chunks merged into nearest-centroid neighbor by cosine of L2-normalized centroids, smallest-first with `(size, min_idea_id)` tie-break (`_merge_undersize`, `partition.py:342-400`). Every tie-break is explicitly deterministic.

**Progress steps**: fine-grained `(done,total)` on `group_ideas` — `(0, KMEANS_MAX_EPOCHS)` at start, `(epochs_run, 10)` per epoch, forced to `(10,10)` on early convergence or `k==1` so the bar never stalls (`partition.py:242-270,227-230`).

**LLM calls**: none. **Embeddings**: consumed, not produced.

**Determinism**: **EXACT** within Python (seeded, deterministic tie-breaks; docstring asserts "Fully deterministic for a given embedding set + target token budget," `partition.py:6-7`). **Cross-language caveat for M4.1**: bit-exact reproduction in TS requires porting sklearn's MiniBatchKMeans/KMeans numerics faithfully (same init, batch iteration order, float accumulation) — the one "mechanical" phase where cross-language bit-exactness is not free; the golden harness must decide between a faithful numeric port vs. treating partition assignments as Python-pinned goldens.

### 2b — synthesize (`abstract/synthesize.py:1-417`)

**Inputs**: `chunks: list[list[UUID]]` from partition; `IdeaService.iter_source_cards(vault_id)` streamed with early-stop once every wanted idea id is found (`_build_synthesis_index`, `synthesize.py:310-332`) — builds an in-memory index of only the ideas the chunk set references (memory-bounded by design, docstring `synthesize.py:73-74`).

**Outputs**: no direct DB writes — returns `list[LocalTopic]` in-memory (feeds premerge). One `compile_cache` row per chunk, `phase="synthesize"`.

**Cache key — exact, verbatim** (`synthesize.py:336-341`), one per chunk:
```python
def _cache_key(*, idea_ids: list[UUID], prompt_hash: str, model: str) -> str:
    return content_hash(
        *sorted(str(iid) for iid in idea_ids),   # sorted — order-independent within a chunk
        f"prompt={prompt_hash}",
        f"model={model}",
    )
```
Called as `_cache_key(idea_ids=chunk, prompt_hash=ph, model=MAP_MODEL)` (`synthesize.py:237`). The key sorts idea-id strings, so chunk-internal order doesn't affect hits — only chunk *membership* does.

**Progress steps**: `synthesize_topics` ("Synthesizing topics") — emitted **per-chunk-completion** inside the `asyncio.as_completed` loop (`synthesize.py:114-136`): `counts={"synthesize_topics": (chunks_done, len(chunks))}` — the SSE stream sees counts climb chunk-by-chunk.

**LLM call**: one per chunk. Prompt `synthesize` (`core/default_prompts/synthesize.md`, 31 lines; standard vault-override-then-default `load_prompt` chain). Model = `MAP_MODEL = "deepseek/deepseek-v3.2"` ("cheap, volume-heavy," `llm/providers.py:14-16,28`). `temperature=0.3`. **`response_format` NOT overridden** — plain `{"type": "json_object"}` (`synthesize.py:272-277`) — synthesize is **not** on the strict-schema hardening track canonicalize got; output parsed defensively in `_parse_topics` (`synthesize.py:380-410`: drops malformed/non-dict entries, empty slug/title, topics with zero resolved `subsumed_idea_ids`). Idea references use short tags (`idea_1`, `idea_2`, …) mapped back on parse (`_render_idea_block`, `synthesize.py:344-377`); unknown tags silently dropped as hallucinations (`synthesize.py:395-397`). Default `max_parse_retries` (1 retry).

**Per-chunk failure isolation**: `_ChunkOk`/`_ChunkFailed` outcomes (`synthesize.py:206-219`) — `json.JSONDecodeError`/`ValidationError` → `output_parse:{e}`, any other `Exception` → `llm_call:{e!r:.200}` (`synthesize.py:283-286`). **One chunk's LLM failure does not abort the phase** — failed chunks are logged (WARNING), excluded from results, counted in `synthesize_chunks_failed` (`synthesize.py:160-174`). Materially different failure posture from canonicalize/validate, which propagate and abort.

**Determinism**: topic proposals **LLM-DEPENDENT** (temp 0.3, non-strict schema — the least-constrained LLM substep in abstract). Cache-key construction + idea-tag resolution **EXACT**. **Embeddings**: none directly (reads idea text, no vector math).

### 2c — premerge (`abstract/premerge.py:1-137`)

**Classification**: mechanical/deterministic (docstring: "Fully deterministic. Not cached," `premerge.py:1-17`).

**Inputs**: `local_topics: list[LocalTopic]` from synthesize, passed in-memory (`__init__.py:179-182`); threshold from `settings.compile_premerge_jaccard_threshold` (default `0.8`, `settings.py:68`). No DB/storage reads.

**Outputs**: **no persistence at all** — no DB write, no cache write (explicit: "Not cached: O(N²) Jaccard is cheap at the scale where N is 'local topics across all chunks' (~600 at 10K-doc scale)," `premerge.py:15-17`). Returns `merged_topics: list[LocalTopic]` to the orchestrator.

**Cache key**: **none — premerge is never memoized.** Confirmed genuine absence.

**Algorithm** (union-find over three signals, in this exact order — order matters for chain composition, e.g. A~slug~B, B~title~C → one group {A,B,C}):
1. Sort `local_topics` by `(chunk_idx, str(local_topic_id))` for deterministic representative selection (`premerge.py:36`) — the first member by this key donates slug/title/description/id to the merged representative (`premerge.py:34-35,105`).
2. Union-find with path-halving `find()` and smaller-index-wins `union()` (`premerge.py:41-58`).
3. **Signal 1 — identical slug**: group by exact `t.slug`, union within group (`premerge.py:60-68`).
4. **Signal 2 — identical case-insensitive stripped title**: group by `t.title.strip().lower()` (`premerge.py:70-79`).
5. **Signal 3 — Jaccard > threshold** (strictly greater): for every unordered pair not already unioned, `|s1∩s2|/|s1∪s2|` over `subsumed_idea_ids` sets, skipping empty sets/unions (`premerge.py:81-95`). **Plain set-based Jaccard over idea-ID membership — no embeddings, no cosine**; docstring: "No cosine signal — subtler merges are left to the canonicalize LLM, which has global view and richer semantics to weigh" (`premerge.py:10-13`). (This answers the standing "Jaccard premerge" open-question memory note's *what*, not its *whether-it-earns-its-complexity*.)
6. Final groups: each group's `subsumed_idea_ids` unioned and string-sorted (`premerge.py:97-118`); merged list sorted by `slug` (`premerge.py:120`).
7. Telemetry: `premerge_initial/final/merges_by_slug/merges_by_title/merges_by_jaccard` counts (`premerge.py:122-136`) — the M4.1 harness can assert per-signal merge-count parity, not just final-count parity.

**Progress steps**: none of its own — the orchestrator flips `merge_candidates` ("Merging similar topics") active/complete around it. **LLM calls**: none. **Embeddings**: none.

**Determinism**: **EXACT** — pure set/string operations, deterministic union-find tie-breaks; the easiest bit-exact TS target in the abstract phase.

### 2d — canonicalize (`abstract/canonicalize.py:1-449`)

**Inputs**: in-memory `list[LocalTopic]` from premerge; `self.thematic_hint` (vault config, injected at construction). No direct DB reads.

**Outputs**: no direct DB writes. Returns `list[CanonicalTopicDraft]` in-memory (`topic_id` not yet minted — validate does that). Writes `compile_cache` rows under two phases (below).

**Structure** (docstring `canonicalize.py:1-31`): replaces the old single-shot "bind everything" reduce that over-merged ~1,800 local topics into a handful of catch-alls (the documented membership-cardinality root cause). Now two LLM steps:
1. **registry** (`_build_registry`, `canonicalize.py:232-262`) — one call producing the canonical topic set (title/description/link_targets); **slugs derived code-side** (`_slugify`, `canonicalize.py:362-370`) for determinism, not echoed by the model.
2. **assign** (`_assign`, `canonicalize.py:266-341`) — every local topic *classified* into exactly one canonical via batched calls (`_ASSIGN_BATCH_SIZE = 30`, `canonicalize.py:57`). The classification framing (each local lands on a registry slug or is dropped as orphan) makes the result orphan-free by construction — no single canonical can silently swallow the corpus, unlike the old reduce.

**Cache keys — exact, verbatim.** Two distinct cache phases, `PHASE_REGISTRY = "canonicalize_registry"` and `PHASE_ASSIGN = "canonicalize_assign"` (`canonicalize.py:54-55`):

```python
# canonicalize.py:426-438 — registry cache
def _local_sig(lt: LocalTopic) -> str:
    return content_hash(lt.title, lt.description, str(len(lt.subsumed_idea_ids)))

def _registry_cache_key(ordered: list[LocalTopic], prompt_hash: str, thematic_hint: str) -> str:
    return content_hash(
        *(_local_sig(t) for t in ordered),      # one hash per local topic, in `ordered` sequence
        f"prompt={prompt_hash}",
        f"hint={content_hash(thematic_hint)}",
        f"model={REDUCE_MODEL}",
    )
```
`ordered` = `sorted(local_topics, key=lambda t: str(t.local_topic_id))` (`canonicalize.py:173`) — the sort is for stable batch composition / cache hit-rate, explicitly not convergence (docstring `canonicalize.py:26-31`). Note `_local_sig` hashes the **count** of subsumed ideas (`str(len(...))`), not the idea ids themselves.

```python
# canonicalize.py:441-449 — assign cache, one key per 30-topic batch
def _assign_cache_key(batch: list[LocalTopic], registry_sig: str, prompt_hash: str) -> str:
    return content_hash(
        f"registry={registry_sig}",
        *(f"{t.local_topic_id}:{content_hash(t.title, t.description)}" for t in batch),  # batch order (inherited from `ordered` slices)
        f"prompt={prompt_hash}",
        f"model={REDUCE_MODEL}",
    )
```
`registry_sig` (`canonicalize.py:278-280`) = `content_hash(*(f"{t.slug}|{t.title}|{t.description}" for t in registry))` — over the just-built registry in its natural (LLM-emitted, slug-deduped) order, recomputed fresh inside `_assign` every call (not itself cached).

**Progress steps**: none of its own — orchestrator-emitted, key `canonicalize_registry`, label **"Organizing topics"** (`__init__.py:49-55,186-199,218-232`).

**LLM calls** — both via `json_llm_call` (`core/llm/client.py:245-297`), model = `REDUCE_MODEL = "anthropic/claude-sonnet-4.6"` (`llm/providers.py:35`; hardened in commit `67cd929` — comment at `providers.py:29-34`: "a weaker model over-merges ... and draws a different partition each run, which churns the wiki"):
- **registry call** — prompt `canonicalize_registry` (vault-override-then-default; package default `core/default_prompts/canonicalize_registry.md`, 30 lines), `temperature=0.2`, `response_format=_REGISTRY_SCHEMA` — **strict** `json_schema` (`"strict": True`, `additionalProperties: False`, `canonicalize.py:66-95`): `{topics: [{title, description, link_targets}]}`, all fields required. Default `max_parse_retries` (1 retry).
- **assign call** (per batch, semaphore-bounded concurrency) — prompt `canonicalize_assign` (19 lines), split at `{subtopics_block}` into a prompt-cache-breakpoint prefix (registry block, `cache_control: {"type": "ephemeral"}` — provider-side prompt caching, distinct from the app's `compile_cache`; `canonicalize.py:307-313`) + per-batch suffix. `temperature=0.1`, `response_format=_ASSIGN_SCHEMA` (strict: `{assignments: [{n: int, slug: string}]}`), **`max_parse_retries=2`** (`canonicalize.py:322` — explicitly higher than the registry call).
- **Loud truncation (the `67cd929` hardening)**: `json_llm_call` checks `response.choices[0].finish_reason == "length"` **before** attempting JSON parse (`llm/client.py:269`) — if hit, logs `json_llm_truncated` at ERROR and raises `RuntimeError` immediately (`llm/client.py:273-279`), no silent partial-JSON acceptance, **no retry on truncation** (retrying a token-limit hit would truncate again, per the comment at `llm/client.py:270-272`). Unconditional across both calls (shared helper).
- **Parse-failure retry** (distinct from truncation): `json.JSONDecodeError` on a non-`length` response retries up to `max_parse_retries`, logging `json_llm_parse_retry` (WARNING) then `json_llm_parse_exhausted` (ERROR, with a 500-char raw preview) before re-raising (`llm/client.py:283-295`).
- **Hallucination handling** (schema-valid but semantically bad): a drop, not a retry — `_parse_registry` drops empty-title topics (`canonicalize.py:388-390`); `_parse_assignments` drops out-of-range `n` or unknown `slug` (`canonicalize.py:412-418`) — those locals become **orphans** (silently excluded from any canonical), not errors.

**Determinism**: registry composition + assignment **LLM-DEPENDENT** (this is exactly the known-imperfect over-merge/registry-variance surface the M4 non-goal says to port as-is). `_slugify` **EXACT** (pure function of title + collision counter given a fixed registry). Cache-key construction **EXACT** — reproducibility is bounded by cache-key granularity, not true LLM determinism. **Embeddings**: none.

### 2e — validate (`abstract/validate.py:1-418`)

**Inputs**: `canonical_topics` (from canonicalize) + `local_topics` (premerge's output, passed through for idea-membership resolution — `validate.py:79,89`). DB read: `self.topics.list_for_vault(vault_id)` — **all** existing topic rows, filtered in-memory to non-archived (`active_existing`, `validate.py:92-94`) to find archive candidates. Storage read: `self.storage.read(article_path, strict=False)` per archive candidate (`validate.py:179`).

**Outputs — DB writes**:
- **`topics`** — `repo.upsert(topic_id, vault_id, slug, title, description, compiled_from_hash)` per validated topic (`TopicService.upsert_validated_topics`, `topics/service.py:58-73`), where `compiled_from_hash = content_hash(title, description, *sorted(subsumed_idea_ids))` (`topics/service.py:75-81`) — a DB-column identity hash, **not** a `compile_cache` key. `article_status` (server default `NO_ARTICLE`, `topics/models.py:51`) and `rendered_from_hash` are NOT touched by this upsert — render owns those.
- **`topics`** (archive transition) — `repo.set_archived(topic_id, superseded_by=...)` per archive candidate (`topics/repository.py:173`) — sets `article_status = ARCHIVED` + `superseded_by` (the pointer M1's archived-fallback on `GET /doc/{path}` reads).
- **`wiki_articles`** — `self.wiki_articles.archive_article(vault_id, topic_id, archive_path)` repoints the documents-registry row for the archived article.
- **`topic_membership`/`topic_links`/`topic_related` are NOT written here** — that three-table rewrite is derive's (`derive.py:80`). A TS port organizing work "by abstract sub-phase" could easily misplace `rebuild_derived_tables` into validate; the boundary is: validate = registry (`topics` upsert + archive transitions); derive = the graph.

**Outputs — storage writes** (archive flow, `_move_wiki_to_archive`, `validate.py:171-195`): per archive candidate with a rendered file — parse frontmatter, set `fm["archived"] = True` and (if a successor exists) `fm["superseded_by"] = str(successor_topic_id)`, write to `archive/{topic_id}/{slug}.md`, delete the original `wiki/{slug}.md`. If the candidate never had a rendered article (`content is None`), silently a no-op (`validate.py:180-183`).

**Cache keys**: **none** — validate has no `compile_cache` usage at all; its mechanical steps and its conditional cleanup LLM call re-run fresh every compile. A TS cache-key inventory must not invent a `validate` cache phase.

**Progress steps**: none of its own — orchestrator key `validate_registry`, label **"Finalizing topics"** (`__init__.py:218-232`, folded into the final `completed` emission at `__init__.py:257-266`).

**LLM call — conditional, at most one per compile**: `_cleanup_llm_call` (`validate.py:235-297`) fires **only if** `collisions` (slug collisions among freshly-emitted canonicals, `validate.py:220-227`) or `archive_candidates` (active topics with no matching emitted slug) is non-empty (`validate.py:101`) — a quiet compile makes **zero** LLM calls in validate. Prompt `cleanup` (`core/default_prompts/cleanup.md`, 26 lines — asks for `{slug_renames: [{canonical_tag, new_slug}], supersessions: [{archived_tag, successor_tag}]}`). Model = `REDUCE_MODEL` (`validate.py:35,259`), `temperature=0.1`, **no `response_format` override** — plain `json_object`, not strict-schema-hardened. On any exception: logs `cleanup_failed` at ERROR and **re-raises** — validate (and the compile) aborts; no per-item isolation.

**Hard-fail invariant**: after applying LLM-proposed renames, `_assert_no_collision` (`validate.py:370-380`) requires all final slugs unique — else raises `RuntimeError`, **no mechanical suffix fallback** (docstring `validate.py:13-15`: "cleanup failure should surface rather than silently persist a corrupt registry"). A TS port adding a fallback slug-suffix mechanism would be a behavior change, not parity.

**Slug/topic-id continuity** (`_assign_topic_ids`, `validate.py:388-418`) — **EXACT, mechanical**: per canonical, `repo.get_by_slug(vault_id, slug)`; if found, reuse the existing `topic_id` (identity survives compiles for an unchanged slug); else mint `uuid7()`. This is the only mechanism by which topic identity persists — canonicalize/synthesize never see `topic_id`.

**Determinism**: link-target intersection, collision detection, rename application, no-collision assertion, id continuity, archive rewrite, `compiled_from_hash` — all **EXACT**. Cleanup call's rename/supersession decisions — **LLM-DEPENDENT**, but conditional and narrow-scope (only renames/successor-mapping, never topic composition). **Embeddings**: none.

### `abstract/schemas.py` — `LocalTopic`

`LocalTopic` (`schemas.py:12-25`) — the sole in-memory contract type flowing partition-chunks → synthesize → premerge → canonicalize: `{local_topic_id: UUID (uuid7, minted at synthesize-parse time), chunk_idx: int, slug: str, title: str, description: str, subsumed_idea_ids: list[UUID]}`. `chunk_idx` is retained "for debugging and for the slug-collision cleanup call in 2e validate" (`schemas.py:17-18`) — a cross-cutting field the TS port must not drop. Explicitly never persisted to Postgres (`schemas.py:1-5`) — the abstract phase's intermediate state is pipeline-run-local (in-process, or Effect workflow step state in the TS port).

## Phase 3 — derive (`src/great_minds/core/pipeline/derive.py:1-100`)

**Inputs**: `list[TopicDetail]` passed in directly from abstract's output (`derive.py:55` — no independent DB read of topics). No storage reads.

**Outputs** — three DB tables, all **full delete-then-insert per compile** via `TopicService.rebuild_derived_tables` (`derive.py:80-84` → `topics/service.py:83-100`):
1. **`topic_membership`** (`topic_id`, `idea_id`) — `replace_memberships_for_topics` (`topics/repository.py:197-224`): `DELETE ... WHERE topic_id IN (<batch>)`, then batched INSERT of every `idea_id` in each topic's `subsumed_idea_ids`.
2. **`topic_links`** (`source_topic_id`, `target_topic_id`) — `replace_links_for_vault` (`topics/repository.py:226+`): deletes all rows whose `source_topic_id` is among **all** the vault's topic ids (`topics/repository.py:234-239`), then bulk-inserts edges by resolving each topic's `link_targets` (slugs) against a `slug_to_id` map built from the **current validated batch only** (`topics/service.py:110-118`) — self-references and unresolvable slugs silently dropped (`topics/service.py:115-116`).
3. **`topic_related`** (`topic_id`, `related_topic_id`, `shared_ideas`, `jaccard`) — `compute_pairwise_jaccard` (`topics/repository.py:302+`, SQL self-join over `topic_membership`, pairs with `topic_a < topic_b AND shared > 0`), fanned out bidirectionally, sorted deterministically `candidates.sort(key=lambda x: (-x[2], str(x[0])))` (`topics/service.py:140` — jaccard desc, topic-id-string tie-break), truncated to `settings.compile_derive_related_limit` per topic, then `replace_related` delete-then-insert per topic_id (`topics/repository.py:258-278`).

No hash-column writes — validate's upsert already set `compiled_from_hash` (`derive.py:15-16`).

**Cache keys**: **None.** Docstring: "Mechanical, no LLM, no cache" (`derive.py:3`).

**Progress steps**: `DERIVE_STEP_LABELS = {"find_related": "Connecting related topics"}` (`derive.py:32-34`) — single step, `(0, len(validated))` → `(len(validated), len(validated))` (`derive.py:75-79,95-99`); empty `validated` → immediate `completed`, `reason="no_topics"` logged (`derive.py:56-69`).

**LLM calls**: None. **Embeddings**: none — "related topics" is Jaccard over idea-membership sets (pure SQL COUNT/self-join, no vector column), not embedding similarity.

**Determinism**: **EXACT** — pure SQL projections/joins over persisted data with explicit deterministic tie-breaking.

## Phase 4 — render (`src/great_minds/core/pipeline/render.py:1-712`)

**Inputs**: `validated: list[TopicDetail]` from abstract (via derive, unchanged); existing `wiki/*.md` file listing (`storage.glob("wiki/*.md")`, `render.py:161`, feeds the cache-hit-but-file-missing repair check); ideas + source docs for topics needing a real render, loaded **lazily** only after the cache pre-pass determines which topics actually need heavy context (`render.py:284-291` — "Heavy context loaded only when at least one topic needs rendering").

**Outputs**:
- `wiki/{slug}.md` files — mechanical frontmatter (`topic_id`, `title`, `description`, `tags`) wrapping the LLM-authored body (`_write_rendered_article`, `render.py:420-456`); the LLM never sees or emits frontmatter (module docstring, `render.py:9`).
- `wiki_articles` table upsert, same call, keyed by `file_path`, carrying `render_run_id = pipeline_run_id` — the FK M1 documented as driving `GET /wiki?run=`.
- `topics.rendered_from_hash` set per topic (`topics.set_rendered`, `render.py:212-214,336-339`) — distinct from `compiled_from_hash` (set by validate); this pair is exactly what `lint.py`'s `dirty_topics` (`rendered_from_hash != compiled_from_hash`) and `publish.py`'s `count_dirty` compare.
- `search_index` wiki-scope rows via `search.rebuild_wiki_index` — only invoked if anything was materialized-from-cache or freshly rendered (`render.py:220-238,343-364`); a fully-cache-hit-with-all-files-present render skips even this.

**Cache key — exact, verbatim** (`render.py:698-711`, plus its `compiled_from_hash` dependency at `render.py:690-695`):
```python
def _topic_content_hash(v: TopicDetail) -> str:
    return content_hash(
        v.title,
        v.description,
        *sorted(str(i) for i in v.subsumed_idea_ids),
    )

def _cache_key(*, topic_id: UUID, compiled_from_hash: str, link_targets: list[str], prompt_hash: str) -> str:
    return content_hash(
        str(topic_id),
        compiled_from_hash,
        *sorted(link_targets),
        f"prompt={prompt_hash}",
        f"model={RENDER_MODEL}",
    )
```
Note `compiled_from_hash` here is **recomputed from the live `TopicDetail`** (`_topic_content_hash`) every time, not read from the `topics.compiled_from_hash` DB column validate already set — the two are expected to agree (both hash `title, description, sorted(subsumed_idea_ids)`) but are independently derived; a TS port must reproduce `_topic_content_hash` exactly rather than assume it can substitute a DB-column read (see oddities).

**Three-way cache outcome per topic** (pre-pass, `render.py:167-201`, evaluated before any heavy context loads): (a) **cache miss** → `to_render`, needs a real LLM call; (b) **cache hit but `wiki/{slug}.md` missing from storage** → `to_materialize` — the cached `{body, tags}` payload is replayed straight to storage with **zero LLM calls**, "heals deleted files" per the module docstring (`render.py:12-13`); (c) **cache hit and file present** → true no-op (`cache_hits` counted). A cached value failing `_RenderOutput.model_validate` (schema drift) is treated as a miss (`cache_invalid`, `render.py:192-197`).

**Progress steps**: `plan_articles` ("Planning articles" — the pre-pass classification loop), `write_articles` ("Writing articles" — the LLM fan-out), `index_articles` ("Indexing articles" — the `rebuild_wiki_index` call) (`render.py:88-92`) — matches the recorded taxonomy's first three of five; **no "Reusing cached articles" or "Saving article index" step exists** — cache-hit materialization is silently folded inside `write_articles`'s own bookkeeping (`materialized`/`cache_hits` counters feed the final `completed` log event but never get a dedicated progress step), and index-saving is folded into `index_articles`.

**LLM call**: `RENDER_MODEL = "qwen/qwen3.6-plus"`, `temperature=0.3`, one call per topic needing render. **No structured-output schema** (default `json_object`) but Pydantic-validated: `_RenderOutput = {body: str, tags: list[str]}` with a `tags` field-validator that lowercases/hyphenates/dedupes and **raises `ValueError` on an empty-after-normalization tag** (`render.py:63-85`). Prompt: `load_prompt(storage, "render")`, `{title}`/`{description}`/`{idea_block}`/`{link_targets_block}` substituted per topic. **Deliberate prompt-size optimization**: only the anchor's `claim` text and a numbered citation marker go into the prompt — the verbatim `quote` and source link are restored **code-side** after generation from the pre-built `numbered_anchors` list (`render.py:615-622` — "cuts prompt size dramatically (the 1M-token render failures) with zero loss of citation fidelity," direct evidence of a real prior incident this design fixes). **Durability — the one phase with sub-phase-level step granularity**: each topic's LLM call is wrapped as its own named Absurd step, `phase.steps.step(f"render-topic-llm-{topic_id}-{cache_key}", _call_render_llm, ...)` (`render.py:509-516`, see `steps.py`/Workers sections above) — every other phase is a single step for its whole duration.

**Post-processing/validation** (`_validate_and_postprocess`, `render.py:651-668`): raw body must be non-empty, must **not** start with `---` (the LLM must never emit its own frontmatter block), and must contain at least one top-level `#` heading — any violation raises `ValueError`. Footnote resolution (`resolve_footnotes`, `core/footnotes.py`, out of scope for this pass) consumes the numbered-anchor map to render the final citation section, dropping orphan markers and renumbering contiguously by first appearance (module docstring, `render.py:5-8`).

**Per-topic failure isolation** (`_render_one`, `render.py:473-553`): an LLM-call exception or a post-processing `ValidationError`/`ValueError` becomes `_RenderFailed(topic_id, error)`, logged (`topic_failed`/`body_invalid` WARNING), phase continues over remaining topics. **No LLM fallback model for render** — module docstring is explicit: "a render flake surfaces via missing article, not degraded content" (`render.py:15-18`). A failed topic simply has no `wiki/{slug}.md` this compile; because nothing was cached for a failure, the **same cache key** guarantees a cache-miss (hence a retry) on the next compile — no separate retry bookkeeping needed.

**Determinism**: article body/tags — **LLM-DEPENDENT**. Cache-key construction, the three-way cache classification, frontmatter assembly, footnote renumbering/resolution — **EXACT**.

**Embeddings**: consumed indirectly via `search.rebuild_wiki_index` (embeds changed wiki chunks, same `core/search` mechanism as ingest's raw-scope indexing); render itself makes no direct embedding call.

## Phase 5 — verify (`src/great_minds/core/pipeline/verify.py:1-233`)

**Inputs**: `TopicService.list_for_vault(vault_id, ArticleStatus.RENDERED)` (`verify.py:69`); `WikiArticleService.list_all(vault_id)` (`verify.py:96`), joined in-memory by `topic_id`. Storage: each rendered article's body via `storage.read(wiki_path(topic.slug), strict=False)` (`verify.py:112`) — a missing file is logged (`missing_rendered_file`, `verify.py:114-121`) and skipped, not raised. Also `TopicService.list_links_for_vault` (`verify.py:213-215`, derive's output) for the unmentioned-link cross-check.

**Outputs**: **`backlinks`** table only — `WikiArticleService.replace_backlinks(source_ids, backlinks)` (`verify.py:174-177` → `documents/service.py:213-217` → `documents/repository.py:516-529`): `DELETE ... WHERE source_article_id IN (<walked ids>)`, then bulk INSERT of `(source_article_id, target_article_id)` rows for every resolved, non-self-referential citation in article prose. The two lint signals (unresolved citations, unmentioned intended links) are **log-only, not persisted** (docstring `verify.py:7-17`); `GET /lint` later re-derives unmentioned links in SQL — see PART 1.

**Link extraction** (deterministic regex, not LLM): `extract_wiki_link_targets` (`core/markdown.py:57-59`), `_WIKI_LINK_RE = re.compile(r"\[([^\]]*)\]\((wiki/[^)]+\.md)\)")` (`markdown.py:54`) — unique `wiki/...md` targets in first-seen order (`dict.fromkeys`). Slug via `wiki_slug(link.rsplit("/", 1)[-1])` (`verify.py:130`), resolved against the rendered-topic set; unresolvable slugs increment `unresolved_count` + log `unresolved_citation` (WARNING) without failing the phase.

**Cache keys**: **None.** No `compile_cache` import, no `content_hash` call.

**Progress steps**: `VERIFY_STEP_LABELS = {"check_links": "Checking references"}` (`verify.py:37-39`) — single step, `(done,total)` incremented **per article inside the walk loop** (`verify.py:154-162` — one progress emit per rendered topic; the only spine phase emitting per-item). No rendered topics → immediate `completed` (`verify.py:70-83`).

**LLM calls**: None. **Embeddings**: none.

**Determinism**: **EXACT transformation / LLM-DEPENDENT input** — regex extraction + table rebuild is deterministic given the rendered bodies; the edges vary run-to-run only as render's prose varies.

## Phase 6 — publish (`src/great_minds/core/pipeline/publish.py:1-228`)

**Inputs**: `TopicService.list_for_vault(vault_id, ArticleStatus.RENDERED)` (`publish.py:90-92`), `SourceDocumentService.list_all(vault_id)` (`publish.py:93`).

**Outputs** — three storage artifacts, **no DB writes**:
1. **`wiki/_index.md`** (`WIKI_INDEX_PATH`, `core/paths.py:58`) — `_write_wiki_index` (`publish.py:154-166`): topics sorted by `title.lower()`, bullets `- [{title}]({wiki_path(slug)}) — {description}` (description newline-collapsed), full overwrite via `storage.write`.
2. **`raw/_index.md`** (`RAW_INDEX_PATH`, `core/paths.py:59`) — `_write_raw_index` (`publish.py:172-189`): docs sorted by `(title or file_path).lower()`, bullets `- [{title or file_path}]({file_path}){meta_suffix}{precis_suffix}` (`meta_suffix` = non-null `(genre, published_date, author)` joined; `precis_suffix` = two-space markdown linebreak + precis if present). Full overwrite.
3. **`.compile/<vault_id>/log.md`** (`compile_log_path(sidecar_root)`, `core/paths.py:112`; `sidecar_root` from `settings.data_dir` + vault_id, `paths.py:107`, injected at `service.py:179,254`) — **appended** (`"a"` mode): `## {iso-8601-seconds timestamp}` heading + summary counts block (`_append_compile_log`, `publish.py:210-227`). **Local `pathlib.Path` write, NOT routed through the `Storage` abstraction** (`log_path.parent.mkdir(...)`, `publish.py:212`) — disk-local, not R2-portable (see oddities).

Counts via `_gather_log_counts` (`publish.py:195-208`): `topics_total/rendered/archived` (`TopicService.count_for_vault`), `topics_dirty` (`count_dirty` — `rendered_from_hash != compiled_from_hash` or null, `topics/repository.py:137-153`), `docs_raw`, `chunks_raw`/`chunks_wiki` (`SearchService.count_by_prefix`).

**Cache keys**: **None.** Docstring: "No LLM calls, no cache" (`publish.py:6`).

**Progress steps**: `PUBLISH_STEP_LABELS = {"publish_wiki": "Publishing wiki", "finalize_compile": "Finalizing"}` (`publish.py:41-44`) — two steps: `publish_wiki` `(0,2)` → wiki index → `(1,2)` → raw index → transition to `finalize_compile` with `completed={"publish_wiki"}`, `(2,2)` → log append → final `completed` (`publish.py:84-148`). The `publish`-phase `completed` emission is what flips `pipeline_runs.status` to `COMPLETED` (the only completion path — see pipeline_runs lifecycle).

**LLM calls**: None. **Embeddings**: none.

**Determinism**: **EXACT** structure/formatting given fixed DB state; content echoes LLM-authored title/description/precis (exact transformation of LLM-dependent input). Log counts are exact aggregates.

## `steps.py` — durable sub-step abstraction (`src/great_minds/core/pipeline/steps.py:1-51`)

A thin composable wrapper so phases can run inline or under Absurd's durable-step semantics without an inheritance hierarchy:

- `StepRunner` (frozen dataclass, `steps.py:13-30`) wraps `run: StepFn = Callable[[str, Callable[[], Awaitable[Any]]], Awaitable[Any]]`; `.step(name, fn, *args, **kwargs)` partial-applies and delegates.
- `run_inline_step(name, fn)` (`steps.py:33-34`) — `await fn()`, ignores `name`; via `inline_step_runner()` (`steps.py:45-46`), the default when `build_compile_service` gets no `steps` arg.
- `AbsurdStepAdapter` (frozen dataclass wrapping `absurd_ctx`, `steps.py:37-42`) — `__call__(name, fn)` → `absurd_ctx.step(name, fn)`, Absurd's durable/idempotent step primitive; via `absurd_step_runner(absurd_ctx)` (`steps.py:49-50`), wired from `compile_task` (workers section).

`CompileService.run()` dispatches its seven phases through this, keyed by the literal strings `"phase-ingest"`, `"phase-extract"`, `"phase-abstract"`, `"phase-derive"`, `"phase-render"`, `"phase-verify"`, `"phase-publish"` (`service.py:81-95`) — these become the Absurd step-ledger keys (checkpoint replay on worker crash). Post-cutover the TS engine replaces Absurd, so cross-engine ledger compatibility is a non-goal (drain in-flight compiles at cutover), but the names remain the TS engine's own step keys.

## `service.py` — `CompileService` / `build_compile_service` (`src/great_minds/core/pipeline/service.py:1-263`)

`build_compile_service(...)` (`service.py:167-263`) is the single composition root — constructs all seven phase objects with DI'd dependencies (storage, `AsyncOpenAI` client, session-derived repos/services, **one shared `CompileCacheRepository(session)`** passed to every cache-using phase), loads vault config **once** via `load_vault_config(storage)` (`service.py:187`) and threads `config.thematic_hint`/`config` into extract and abstract. Concurrency knobs read from `Settings` here: `compile_enrich_concurrency` (extract), `compile_write_concurrency` (render), `compile_derive_related_limit` (derive).

**Signature**: `build_compile_service(*, vault_id, pipeline_run_id, progress, storage, session, client, steps=None, settings=None) -> CompileService`; `steps` defaults to `inline_step_runner()`, `settings` to `get_settings()`.

**`CompileService.run()`** (`service.py:75-97`): sequential ingest → extract → abstract → (**early exit**: zero validated topics → `complete_early_no_topics()` (`service.py:146-165`) force-emits a synthetic `publish`-phase `completed` step, `label="compile completed early: no validated topics"`, `done=1/total=1`, returns — **derive/render/verify/publish never run**) → derive → render → verify → publish. Each phase wrapped in `_phase(name)` (`service.py:99-104`, `telemetry_scope` + `timed_op`) and dispatched through `self.steps.step(...)`.

**Failure propagation**: no try/except around any phase — an exception halts the entire compile and propagates to `compile_task`. No partial-completion/skip-ahead; only the zero-topics early exit is deliberate. Retry is whole-task (Absurd), with per-step idempotency from the step ledger.

## Workers (`src/great_minds/core/workers.py`)

### `staged_file_ingest_task` (`workers.py:368-570`)

**Trigger**: `TaskService.spawn_staged_file_ingest` (`core/tasks/service.py:69-111`), called from `PipelineRunService.start_staged_file_ingest` (`pipeline_runs/service.py:117-143`) — the service behind `POST /ingest/staged-files/process` (M3 scope). Absurd `idempotency_key=str(pipeline_run_id)` (`tasks/service.py:91`) — retrying the same `/process` call reuses the same Absurd task. Params (`workers.py:371-375`): `{"vault_id": str, "files": [{"hash","name","mimetype"}...], "pipeline_run_id": str}`.

**Flow**:
1. Validates vault exists and `storage_backend == "r2"` with `r2_bucket_name` set (`workers.py:391-399`) — **hard R2-only requirement**, `ValueError` otherwise (caught by the outer except → `failed` progress event → re-raise for Absurd).
2. Progress `started` then `progress` on `read_files` (`workers.py:422-443`).
3. Fans out `_fetch_and_convert` (`workers.py:202-230`) over all files with `asyncio.Semaphore(_STAGING_FETCH_CONCURRENCY=4)` (`workers.py:198,445-457`): fetches raw bytes from `staging/{vault_id}/{hash}` via `R2Admin.fetch_bytes` (thread-offloaded), converts via `_convert_to_markdown(raw_bytes, name, mimetype)` (imported from `core/ingest_service.py` at `workers.py:28` — **the MarkItDown conversion entry point**; the same shared converter used elsewhere — M3.2 decision-13's PDF/DOCX deferral applies to `/ingest/upload`'s synchronous path specifically; this staged/bulk path already ran the full converter and nothing in workers.py changes that surface), then prepends frontmatter via `build_document(content, source_type="document")` (`workers.py:227`).
4. **Per-file error isolation**: `_fetch_and_convert` never raises — exceptions are caught and returned as the third tuple element (`workers.py:212-217,229-230`, explicitly because `asyncio.as_completed` loses the originating entry on a raised exception). `_index_fetched_results` (`workers.py:240-343`) drains via `as_completed`; each failed fetch increments `failed`/logs a warning (`workers.py:280-291`) and **continues** — one file's conversion failure never aborts the batch.
5. Per successful fetch: computes `file_hash(content_with_fm)`, dest path `raw/docs/{hash[:12]}.md` (content-addressable), skips if `existing_hashes.get(dest) == file_hash_val` or already seen this run (`workers.py:297-299`), else writes to storage and batches, flushing every `_STAGING_BATCH_SIZE=50` via `doc_service.batch_index` (`workers.py:301-325`) — each flush also emits incremental progress.
6. **Compile-intent emission — exactly once per run, at the end, only if `ingested > 0`** (`workers.py:496-522`): `intent_repo.ensure_pending(vault_id, pipeline_run_id=pipeline_run_id)`, then `pipeline_run_repo.attach_compile_intent`, commit, **then** best-effort `_cleanup_staging` — deliberately after commit (comment at `workers.py:504-507`: cleanup-before-commit risks losing staging keys on a mid-transaction crash, causing `NoSuchKey` on task retry and masking the real error) — then a `completed` progress event for `source_ingest`.
7. `ingested == 0 and failed > 0` → `failed` event, no intent, no compile queued (`workers.py:523-538`).
8. `ingested == 0 and failed == 0` (every file deduped) → emits a **`publish`-phase `completed`** event labeled `"sources already up to date"` (`workers.py:539-553`) — deliberate phase-spoofing so the UI shows a clean terminal state instead of stalling on `source_ingest` (the SSE section documents why the frontend tolerates the phase jump).
9. Outer `except Exception` (`workers.py:557-570`): `failed` progress event on the `prepare_sources` step with `str(exc)` as detail and top-level `error`, then re-raise so Absurd records the failure.

**Idempotency**: content-addressable dest paths + `SourceDocumentRepo.batch_upsert`'s `(vault_id, file_path)` conflict target (docstring `workers.py:377-381`) — re-running on the same hashes is a no-op. Registered `default_max_attempts=2` (`workers.py:595-597`), no explicit `retry_strategy` — ground truth traced into `absurd.fail_run` (`alembic/absurd.sql:672-825`): an unset `retry_strategy` defaults `kind` to `'none'` (`coalesce(v_retry_strategy->>'kind', 'none')`, `absurd.sql:747`), which takes the zero-delay branch (`v_delay_seconds := 0`, `absurd.sql:754`) — a failed attempt is re-queued **immediately as `pending`** (not `sleeping`), no backoff at all. With `max_attempts=2`, `staged_file_ingest` retries **exactly once**, with zero delay, before giving up.

### `compile_task` (`workers.py:98-190`)

**Trigger**: exclusively the reconciler's `_dispatch_pending` (`compile_intents/reconciler.py:107-113`) via `TaskService.spawn_compile_for_intent` (`tasks/service.py:113-159`) — **no HTTP route spawns a compile task directly**; `POST /compile` only writes/ensures a `CompileIntent` row. Absurd `idempotency_key=str(intent_id)` (`tasks/service.py:138`) — spawning N times for one intent is safe.

**Retry config**: registered `default_max_attempts=3` (`workers.py:594`); spawn also passes explicit `max_attempts=3, retry_strategy=COMPILE_RETRY` (`tasks/service.py:133-139`), `COMPILE_RETRY = {"kind": "exponential", "base_seconds": 10.0, "factor": 2.0, "max_seconds": 300.0}` (`tasks/service.py:19-24`) — 3 total attempts, 10s then 20s between them.

**Flow**:
1. Acquires a **Postgres session advisory lock** per vault (`hashtextextended(vault_id, 0)`) on a *separate* asyncpg connection (`workers.py:56-76,148-156`), held for the task's full duration (the SQLAlchemy session commits mid-task between phases) — the hard one-compile-per-vault mutual exclusion.
2. Starts a background heartbeat loop **only after the lock is acquired** (deliberate ordering, `workers.py:158-162`: starting earlier would let a stuck lock acquisition keep the Absurd claim alive forever, defeating the zombie detector) — `ctx.heartbeat(120)` every 60s, half of Absurd's 120s claim timeout.
3. Builds the compile service via `build_compile_service(..., steps=absurd_step_runner(ctx))` — each pipeline phase becomes an Absurd durable `ctx.step()` checkpoint ("on worker crash, Absurd replays from the last completed checkpoint," `workers.py:99-107`).
4. `await compile_service.run()`, then `record_wide_event_cost` + commit.
5. **On any exception** (`workers.py:179-181`): `progress.fail(pipeline_run_id, str(exc))` — immediately writes `pipeline_runs.status=FAILED, phase_status=FAILED, error=str(exc), completed_at=now()` (`pipeline_runs/repository.py:138-151`) — **then re-raises**, so Absurd records the attempt and retries per `COMPILE_RETRY` if attempts remain (see oddity on first-attempt-failure visibility).
6. `finally`: release advisory lock, cancel/await heartbeat, emit wide event.

**Cancellation**: cooperative and DB-first — documented in the SSE section (Termination). `TaskService.cancel(active_task_id)` → `absurd.cancel_task(task_id)` (a Postgres-side call); the task actually stops at its next `ctx.step()`/heartbeat boundary (`tasks/service.py:190-194`). Between the DB `cancelled` write and the next checkpoint, the compile keeps running and can still emit progress/DB writes that land after the run is marked cancelled — not guarded against (see oddities).

## Compile-intents reconciler (`src/great_minds/core/compile_intents/reconciler.py`)

**Wiring**: an `asyncio.create_task` inside FastAPI `lifespan` (`server.py:98`), 1:1 with the API process — explicitly a "single-process choice" (`server.py:94-98`). Ticks every `RECONCILER_INTERVAL_SECONDS = 5.0` (`server.py:39,147`) in an infinite loop with its own exception guard (a failed tick logs a warning and continues — never crashes the process, `server.py:120-147`); cancelled and awaited on shutdown (`server.py:102-106`).

**Each tick, one DB session/transaction** (`server.py:121-139`):
1. `reconcile_once(...)` (`reconciler.py:36-53`) — two scans:
   - **Mark satisfied** (`_mark_satisfied_terminal`, `reconciler.py:56-79`): every dispatched-but-unsatisfied intent (`list_dispatched_unsatisfied`, ordered by `dispatched_at`, limit 200) is checked against Absurd's `fetch_task_result`; terminal task state (`completed|failed|cancelled`) → `satisfied_at = now()`.
   - **Dispatch pending** (`_dispatch_pending`, `reconciler.py:82-125`): `list_pending_locked()` — `SELECT ... WHERE dispatched_at IS NULL ORDER BY created_at LIMIT 100 FOR UPDATE SKIP LOCKED` (`compile_intents/repository.py:52-61`, multi-process-safe scan). Per intent: **skip if `task_service.find_active_compile(vault_id)` finds a task in `pending|running|sleeping`** (`reconciler.py:92-93`) — the "at most one in-flight compile per vault" invariant, enforced here, not in DDL. If the intent lacks a `pipeline_run_id`, creates one (`trigger=MANUAL`) and attaches both ways (`reconciler.py:96-104`). Then `spawn_compile_for_intent` + `mark_dispatched(intent.id, task.id)`.
2. `_recover_zombie_pipeline_runs` (`server.py:150-186`) — separate scan directly on `pipeline_runs`: any `pending|running` run with `updated_at` older than 120s (`server.py:156-157`) is a zombie. No `active_task_id` → failed with `"Pipeline lost — server may have restarted."` With one → fetch the Absurd task snapshot; missing snapshot or state in (`failed`,`cancelled`) → failed with `"Pipeline interrupted — server may have restarted during processing."` **Note: a `completed` task snapshot matches neither condition — such a run silently falls through with no action** (see oddities).
3. Single `session.commit()` for both.

**Outbox idempotency**: `ensure_pending` is one atomic `INSERT ... ON CONFLICT (vault_id) WHERE dispatched_at IS NULL DO UPDATE SET vault_id=vault_id RETURNING *` against a partial unique index (`compile_intents/models.py:19-24`, `repository.py:27-50`) — coalesces concurrent ingest-triggered intents into one undispatched row per vault; the no-op `DO UPDATE` (vs `DO NOTHING`) exists so `RETURNING` still yields the existing row.

## `pipeline_runs/` lifecycle

**Status enum** (`PipelineRunStatus`, `pipeline_runs/schemas.py:10-15`): `pending | running | completed | failed | cancelled`. `PipelineRunFilter` (`schemas.py:18-31`) adds synthetic `active` (= pending ∪ running) for the jobs-list query param.

**`current_phase`/`phase_status`**: separate free-text columns (`models.py:27-28`, typed `Text`, populated from `PipelinePhase`/`PipelinePhaseStatus` StrEnums but stored untyped). `PipelinePhase`: `upload | source_ingest | ingest | extract | abstract | derive | render | verify | publish` (`schemas.py:40-49`); `PipelinePhaseStatus`: `started | progress | completed | failed` (`schemas.py:57-61`).

**`progress_steps` JSONB shape**: `list[PipelineProgressStep]` = `{key: str, label: str, status: PipelineStepStatus, done: int|None, total: int|None, detail: str=""}` (`schemas.py:71-77`), stored via `model_dump(mode="json")` (`repository.py:189-191`), column default `'[]'::jsonb` (`models.py:29-31`). `PipelineStepStatus` (`pending|running|completed|failed`, `schemas.py:64-68`) is a **different enum from `PipelinePhaseStatus`**; `phase_step()` (`service.py:44-60`) maps via `_STEP_STATUS_BY_PHASE_STATUS` (`service.py:36-41`): `STARTED→RUNNING, PROGRESS→RUNNING, COMPLETED→COMPLETED, FAILED→FAILED`.

**State transitions** — enforced only by `update_progress`'s conditional logic (`repository.py:181-219`), no DB constraint / explicit state machine:
- `phase_status == FAILED` → run `FAILED`, `completed_at=now()` — terminal regardless of phase.
- `phase == PUBLISH and phase_status == COMPLETED` → run `COMPLETED`, `completed_at=now()` — the **only** completion path; everything else → `RUNNING`.
- **No guard prevents progress writes onto an already-terminal run** — a racing `PipelineProgressRunner.emit` after `cancel()`/`fail()` committed can flip a terminal row back to `RUNNING` (or `COMPLETED`), since `update_progress` has no `WHERE status NOT IN (terminal)` guard — unlike `cancel()`'s own `WHERE status IN (_ACTIVE)` race guard (`repository.py:163-169`).
- `cancel()`/`fail()` are the exclusively-terminal writers, using `RETURNING` to detect no-op application (`None` → e.g. cancelling an already-terminal run; `PipelineProgressRunner.fail`/`.emit` roll back instead of committing in that case, `service.py:153-186`).

**`trigger` values** (`PipelineTrigger`, `schemas.py:34-37`): `staged_files` (staged-upload `/process`), `url` (`POST /jobs/url`, M3), `manual` (**both** `POST /compile` via `request_compile`, `compile_intents/service.py:32-38`, **and** the reconciler's auto-created run for a run-less intent, `reconciler.py:96-104` — no value distinguishes the two origins).

**Embeddings**: no direct embeddings usage anywhere in `workers.py`/`compile_intents/*`/`pipeline_runs/*` — pure orchestration/lifecycle; embeddings live inside the pipeline phases (ingest/extract).

## Progress-steps taxonomy — recorded note vs. actual code

The recorded taxonomy (the napkin note quoted in the M4 planning inputs) was an early design target, **never fully implemented** — every phase except URL-ingest shipped with fewer/coarser steps, and several labels were reworded. **The current code's `STEP_LABELS` dicts are the contract**, tabulated verbatim:

| phase | file:line | actual keys → labels | recorded-note drift |
|---|---|---|---|
| ingest | `pipeline/ingest.py:25-27` | `index_sources: "Indexing for search"` | 1 step, not 3 ("Loading sources"/"Preparing searchable text"/"Indexing sources" don't exist) |
| extract | `pipeline/extract.py:53-56` | `extract_cards: "Extracting source cards"`, `embed_ideas: "Embedding ideas"` | 2 steps, not 4 (no "Preparing document list"/"Saving extraction index") |
| abstract | `pipeline/abstract/__init__.py:49-55` | `group_ideas: "Grouping ideas"`, `synthesize_topics: "Synthesizing topics"`, `merge_candidates: "Merging similar topics"`, `canonicalize_registry: "Organizing topics"`, `validate_registry: "Finalizing topics"` | same 5 keys; 3 of 5 **labels** differ (user-facing copy was softened) |
| derive | `pipeline/derive.py:32-34` | `find_related: "Connecting related topics"` | 1 step, not 2 |
| render | `pipeline/render.py:88-92` | `plan_articles: "Planning articles"`, `write_articles: "Writing articles"`, `index_articles: "Indexing articles"` | 3 steps, not 5 (no "Reusing cached articles" — cache-hit skipping is silent inside `write_articles`; no "Saving article index") |
| verify | `pipeline/verify.py:37-39` | `check_links: "Checking references"` | 1 step, not 3 |
| publish | `pipeline/publish.py:41-44` | `publish_wiki: "Publishing wiki"`, `finalize_compile: "Finalizing"` | 2 steps, not 3; "Finalizing" not "Finalizing compile" |
| staged ingest | `workers.py:233-236` | `prepare_sources: "Preparing uploaded sources"`, `read_files: "Reading uploaded files"`, `index_documents: "Indexing documents"` | 3 steps, not 5 — cleanup (`workers.py:508`) and compile-queuing (`workers.py:497-502`) happen but are folded silently into `index_documents`'s completion; label "Indexing documents" not "Indexing source documents" |
| URL ingest | `core/jobs/service.py:27-31` | `fetch_url: "Fetching source URL"`, `convert_document: "Converting source document"`, `index_document: "Indexing source document"` | matches the note's first 3 exactly; "Queuing compile" is not a tracked step |

## Determinism classification summary

| Artifact | Phase | Classification | Reason |
|---|---|---|---|
| `search_index` chunk rows (raw) | ingest | EXACT | deterministic chunking of raw bytes |
| `search_index` embedding vectors | ingest/extract/render | LLM-DEPENDENT | embedding-model output, not bit-guaranteed |
| `source_documents.etag` | ingest | EXACT | mirrors storage-reported ETag |
| `SourceCard` / idea content (title, precis, tags, ideas) | extract | LLM-DEPENDENT | `EXTRACT_MODEL`, strict schema, per-doc isolation |
| Extract cache-key construction, anchor localization, frontmatter mirror | extract | EXACT | pure `content_hash` + substring matching |
| Idea embedding vectors | extract | LLM-DEPENDENT | `EMBEDDING_MODEL`, not compile-cached; can silently timeout-skip a batch |
| Partition chunk assignments + cache value | abstract 2a | EXACT* | seeded k-means, deterministic tie-breaks; *cross-language numeric-parity risk (sklearn) |
| Local topic proposals per chunk | abstract 2b | LLM-DEPENDENT | `MAP_MODEL`, temp 0.3, non-strict schema, per-chunk isolation |
| Partition/synthesize/canonicalize cache-key construction | abstract | EXACT | pure `content_hash` over defined inputs |
| Premerge merged-topic set | abstract 2c | EXACT | pure set/string ops, deterministic union-find |
| Registry topic set (title/description/link_targets) | abstract 2d | LLM-DEPENDENT | `REDUCE_MODEL`, strict schema; known-imperfect over-merge surface, port as-is |
| Slug derivation from registry titles | abstract 2d | EXACT | `_slugify`, pure function |
| Local→canonical assignment | abstract 2d | LLM-DEPENDENT | batched classification, strict schema |
| Cleanup renames/supersessions | abstract 2e | LLM-DEPENDENT (conditional) | fires only on collision/archive churn |
| Collision detection/assertion, id continuity, archive move, `compiled_from_hash` | abstract 2e | EXACT | pure ops / DB lookups |
| `topic_membership`, `topic_links`, `topic_related` | derive | EXACT | SQL projections with deterministic tie-breaks |
| Article markdown bodies | render | LLM-DEPENDENT | see render section |
| Render cache keys / frontmatter assembly | render | EXACT | see render section |
| `backlinks` rows | verify | EXACT transform / LLM input | regex over LLM prose |
| `wiki/_index.md`, `raw/_index.md` | publish | EXACT transform / LLM input | deterministic formatting of LLM fields |
| `.compile/<vault_id>/log.md` | publish | EXACT | DB-state aggregates |
| `pipeline_runs.progress_steps` | all | EXACT | deterministic given execution state |

---

# Contract oddities

Recorded for human decision, not resolved. Consolidates the per-section flags (Part 1 oddities #1-9 and SSE oddities #1-8 above are incorporated by reference where they overlap); numbered independently for this doc.

1. **First-attempt compile failure is terminal-visible before Absurd retries (the recorded napkin gap, now confirmed).** `compile_task`'s `except` calls `progress.fail()` unconditionally (`workers.py:179-181`) then re-raises; Absurd may retry up to 2 more times (`COMPILE_RETRY`). `update_progress` has no terminal-state guard, so a successful retry *does* flip the row back `running`→`completed` — but the SSE frontend treats the first `failed` snapshot as terminal and stops following; a backend recovery on attempt 2/3 is invisible to an open UI session (only a fresh page load sees it). Human decision: defer the `pipeline_runs` fail-write until Absurd's attempts are truly exhausted (requires threading "is this the last attempt" into the task), or keep current behavior and have the TS SSE client resubscribe after a `failed` terminal event.
2. **Cancellation is racy against in-flight progress writes.** `cancel()` commits `CANCELLED` before the cooperative task cancel lands (`pipeline_runs/service.py:75-76`, intentional for UI immediacy), but `update_progress` has no `WHERE status NOT IN (terminal)` guard — a phase's next progress emit already in flight can silently resurrect a cancelled run to `RUNNING`. `cancel()`'s own conditional-update race guard protects the other direction only.
3. **Zombie recovery misses the completed-task/stale-run case.** `_recover_zombie_pipeline_runs` (`server.py:172-185`) only acts when the Absurd snapshot is missing or `failed`/`cancelled` — a task that actually `completed` but whose final `update_progress` never landed leaves the run hanging in `running` forever, unrecovered.
4. **`staged_file_ingest`'s "nothing to ingest" branch spoofs a `publish`-phase completed event** (`workers.py:539-553`) — structurally inconsistent (a `source_ingest` run whose only event names `publish`) but tolerated by the frontend's index-based stage advancement; same shape as `complete_early_no_topics()`'s synthetic publish completion (`pipeline/service.py:146-165`), which likewise reports `phase=publish, status=completed` when derive/render/verify/publish never actually ran. Both are deliberate UI-legibility hacks — the TS port must reproduce them or make early-exit states structurally distinct (a protocol change).
5. **No DB-level enforcement of one-active-compile-per-vault** — enforced only by the reconciler's look-then-act `find_active_compile` check (`reconciler.py:92-93`) plus the per-vault advisory lock inside the task itself (`workers.py:56-76`); safe single-process, explicitly flagged in code comments as a multi-instance risk (`compile_intents/repository.py:8-10`).
6. **`PipelineTrigger.MANUAL` conflates user-initiated `POST /compile` with reconciler auto-created runs** for run-less intents (`reconciler.py:96-104`) — no provenance distinction.
7. **`.compile/<vault_id>/log.md` bypasses the `Storage` abstraction** — bare local-disk `pathlib` append (`publish.py:210-227`), unlike every other pipeline artifact. On an R2-backed vault the compile log is not replicated and dies with the node. Keep local-only or migrate into `Storage` — behavior change either way.
8. **Progress-step taxonomy drift** — the recorded napkin taxonomy was never fully implemented (see the cross-check table); the code's `STEP_LABELS` dicts are the contract. Also three of five abstract labels were softened ("Merging similar topics"/"Organizing topics"/"Finalizing topics"). Refresh the napkin; port the code strings.
9. **The strict-schema hardening covers only canonicalize's two calls** (`67cd929` touched `llm/client.py`, `llm/providers.py`, `canonicalize.py` only) — synthesize and validate's cleanup call still use bare `json_object` with defensive drop-on-malformed parsing. If registry-instability reappears, these two under-hardened call sites are the likelier suspects. "Canonicalize was hardened" ≠ "the abstract LLM surface was hardened."
10. **Failure-isolation posture differs by call site with no documented policy**: synthesize isolates per chunk (drop and continue); canonicalize registry/assign and validate cleanup propagate and abort the compile; extract isolates per document (see extract section). A TS port that habitually harmonizes ("make everything per-item resilient") silently changes observable behavior.
11. **Partition is deterministic in Python but not freely portable** — seeded sklearn `MiniBatchKMeans`/`KMeans` with manual epoch loops (`partition.py:32-38,242-270`); TS has no numerics-identical equivalent. M4.1 must decide: faithful numeric port (bit-exact goal) vs. Python-pinned goldens for partition assignments (statistical envelope for everything downstream of a partition difference).
12. **Cache-key input granularity is intentionally inconsistent across phases** — partition hashes the vault-wide sorted idea-id set; synthesize hashes the sorted per-chunk id set; canonicalize's registry key hashes per-topic `(title, description, len(ids))` signatures (the **count**, not the ids); render hashes `topic_id` + a **recomputed** content hash (`_topic_content_hash`: `title`, `description`, sorted `subsumed_idea_ids` — no file hash of any kind is part of the key) + sorted `link_targets` + `prompt` + `model` (see render section). Each choice is defensible in isolation, but the *count-not-ids* choice in `_local_sig` (`canonicalize.py:426-428`) means an edit that swaps one subsumed idea for another (same count, same title/description) produces a **cache hit on a stale registry** — accidental-looking; flag for a human call (port as-is per the non-goal, but record it).
13. **Validate has no cache; premerge has no cache** — genuine, documented absences (`premerge.py:15-17`; validate confirmed by grep). The TS cache-key inventory has exactly **six** compile_cache phases: `partition`, `synthesize`, `canonicalize_registry`, `canonicalize_assign`, plus render's (see render section) and extract's (see extract section) — do not invent others.
14. **`compile_cache.put` is `ON CONFLICT DO NOTHING` with no TTL/GC** (`compile_cache/repository.py:29-41`) — entries accumulate forever; nothing ever deletes or updates them. Fine at current scale, but the TS port inherits an unbounded table by design.
15. **`refresh_etag_batch` silently drops ETags for unregistered paths** (`ingest.py:84-86`) — the "file exists, DB doesn't know it" family M1 documented for `/doc/{path}`, recurring in the pipeline layer.
16. **Verify emits one progress write per rendered article** (`verify.py:154-162`) — a short independent transaction per article, O(articles) DB round-trips per compile, unlike every other phase's start/end/milestone cadence. Preserve deliberately (reconnect-snapshot freshness) or batch consciously — don't accidentally "optimize" it away.
17. Part 1 route-level oddities (incorporated by reference): dead `cost_routes.py` surface (both mounts, zero frontend callers); vestigial `JobResponse.stream_url`; cancel's `204`-always with no existence check; `POST /compile`'s untyped-500 invariant failure; `dirty_topics` bare UUIDs; dead duplicate `web/src/api/compile.ts::compile()` client.
18. SSE-level oddities (incorporated by reference): unmappable `phase:""`/`"upload"` snapshots; no frontend Zod on the SSE payload; single shared NOTIFY channel fan-out; cancellation's `phase_status=FAILED` + load-bearing frontend check order; cancelled-before-stopped consistency window; backoff-reset asymmetry; `connected` frame carrying no data.
19. **Extract's post-LLM stages are phase-fatal, not per-document isolated.** Unlike `_extract_one`'s per-document try/except (LLM call + parse + anchor localization), the block that runs after the per-doc loop completes — `ideas.delete_for_documents` (stale idea cleanup for cache-miss docs), the `_embed_in_batches`/`ideas.record_extractions` embed-and-persist loop, and the on-disk frontmatter rewrite for every freshly-extracted doc (`extract.py:215-243`) — has no per-doc isolation at all. A single doc's stale-row delete, embedding-batch call, or frontmatter write raising an exception propagates and aborts the whole extract phase, unlike a doc whose LLM call itself fails (which is cleanly isolated as `_ExtractFailed`). A TS port assuming "extract is per-doc resilient end-to-end" would be wrong for this tail — the isolation boundary is narrower than the phase.
20. **`extract.py`'s `EMBEDDING_BATCH_SIZE = 50` (`extract.py:51`) is a distinct, independently-declared constant from `core/search/service.py`'s own `EMBEDDING_BATCH_SIZE = 50` (`search/service.py:28`).** Same value today, but coincidence, not a shared source — the two embedding-batching call sites (extract's direct `client.embeddings.create` path vs. search's `rebuild_raw_index`/`rebuild_wiki_index` path) can drift independently. A TS port should declare two separate constants, not unify them into one shared value that would silently couple the two systems.
21. **Render's `_topic_content_hash` (`render.py:698-705`) must be reproduced exactly in TS — it is not interchangeable with a DB-column read.** It recomputes `content_hash(title, description, *sorted(subsumed_idea_ids))` fresh from the live `TopicDetail` on every render call — the same formula validate uses to set `topics.compiled_from_hash`, but independently derived rather than read from that column (see the render cache-key section). The two are expected to agree today, but a TS port that "optimizes" by substituting a `topics.compiled_from_hash` column read for the recomputation would still match current values while silently changing the cache key's actual dependency graph (a DB round-trip / different staleness window instead of a pure function of the in-memory `TopicDetail`) — port the recomputing function, not a shortcut that happens to agree with it today.
22. **Cancel→FAILED clobber — live-bug candidate, statically traced.** `PipelineRunRepository.fail()` (`pipeline_runs/repository.py:138-151`) has **no** `status IN (_ACTIVE)` guard, unlike `cancel()` (`repository.py:163-179`) — `fail()`'s `UPDATE` is unconditioned on current status, so it will overwrite any row (including an already-`CANCELLED` one) back to `status=FAILED, phase_status=FAILED`. Absurd's `CancelledTask` (raised into a task on cooperative cancellation) **subclasses `Exception`**, so `compile_task`'s generic `except Exception` handler (`workers.py:179-181`) catches it too and calls `progress.fail(pipeline_run_id, str(exc))` — unconditionally, with no check for whether the run was already cancelled. This can land *after* `PipelineRunService.cancel()` has already committed `status=CANCELLED` (the intentional NOTIFY-before-teardown ordering documented above), clobbering the terminal `CANCELLED` state back to `FAILED`. Not runtime-reproduced in this pass — confirmed by static trace of both code paths, not by observed behavior. **Human decision needed**: the TS port most likely wants `cancelled` to be terminal-stable (a `fail()`-equivalent that no-ops on an already-terminal row, mirroring `cancel()`'s own guard), rather than reproducing this clobber as-is. See the "cancel mid-compile" fixture requirement below, which must capture whichever behavior is chosen.

---

# Fixture requirements

What a golden-compile corpus (M4.1 characterization harness) needs to exercise every behavior documented above. Builds on M1/M3's fixture base (users/vaults/memberships/sources).

- **Multi-doc corpus, compile from scratch**: enough raw sources to produce multiple ideas per document and multiple partition chunks (i.e. total estimated tokens > `compile_partition_target_tokens`, or a lowered setting) — exercises k>1 partition, per-chunk synthesize fan-out, premerge across chunks, batched assign (>30 local topics to force a second assign batch), and the full seven-phase spine. Record goldens: partition cache key + chunk assignments, per-chunk synthesize cache keys, registry/assign cache keys, all `compile_cache` rows, `topics`/`topic_membership`/`topic_links`/`topic_related`/`backlinks` rows, `wiki/` file tree, `_index.md` bytes, `progress_steps` sequences per phase.
- **Incremental recompile, nothing changed**: immediate second compile of the same corpus — every cache phase must hit (partition/synthesize/canonicalize registry+assign/extract/render), zero new LLM calls in cassette mode, `topics.topic_id` stability via `_assign_topic_ids` slug-reuse, and identical `compiled_from_hash` values. Also the **staged-ingest no-op path**: re-upload identical files → `ingested==0, failed==0` → the spoofed `publish`-completed SSE event (`workers.py:539-553`).
- **Incremental recompile, one doc added/edited**: only affected extract cache keys miss; partition key changes (vault-wide id set); downstream keys drift accordingly. Asserts the convergent-incremental story (cache-hit skipping inside `write_articles` for unchanged topics via `rendered_from_hash`/cache key).
- **Archived-topic flow**: a compile whose registry drops a previously-rendered topic — exercises validate's `archive_candidates`, the cleanup LLM call (cassette), `set_archived` + `superseded_by` (both a with-successor and a `successor_tag: null` → `superseded_by=None` case), the `archive/{topic_id}/{slug}.md` file move with frontmatter rewrite, and M1's `/doc/{path}` archived-fallback reading the result. Also an archive candidate that never had a rendered file (silent no-op branch, `validate.py:180-183`).
- **Slug collision**: two canonicals emitting the same slug — exercises `_detect_collisions`, the cleanup LLM rename, and (as a negative test) `_assert_no_collision`'s `RuntimeError` when the cassette returns an unresolving rename.
- **Zero-topics early exit**: a corpus/cassette producing no validated topics — `complete_early_no_topics()`'s synthetic publish completion; derive/render/verify/publish side effects must be absent.
- **Empty vault**: zero ideas → partition returns `[]` → abstract's `no_chunks` short-circuit (`abstract/__init__.py:124-135`).
- **Per-item failure isolation**: cassette-scripted failures — one synthesize chunk failing (phase continues, `synthesize_chunks_failed` counted); one extract document failing (per-doc isolation); a canonicalize registry failure (whole compile aborts, run `FAILED`); a truncation (`finish_reason: "length"`) response (loud `RuntimeError`, `json_llm_truncated` log, no retry); a parse failure retried then exhausted; an assign response with out-of-range `n`/unknown `slug` (orphan drop, not error).
- **Compile task infrastructure**: a compile failing on attempt 1 and succeeding on attempt 2 (Absurd retry + step-ledger replay — completed phases must not re-execute; asserts the first-attempt `FAILED` row being resurrected to `COMPLETED`, oddity #1); a cancel mid-compile (SSE `cancelled` snapshot before task stop, `phase_status=FAILED` + `job_status=cancelled` shape, the cancel-then-progress-write resurrection race if reproducible, **and specifically the cancel→FAILED clobber path from oddity #22** — a cancellation whose cooperative teardown raises Absurd's `CancelledTask` back into `compile_task`'s generic exception handler after `CANCELLED` has already committed; the golden must capture today's actual outcome (`FAILED` wins) so a TS port's deliberate fix — making `cancelled` terminal-stable — is a visible, reviewable behavior change rather than a silent one); cancel of an already-terminal run (204 no-op); two rapid `POST /compile` calls (single pending intent via the partial unique index; second run not spawned while the first is active; **and a variant where the first call's intent already has a `pipeline_run_id` attached — asserts the second call's client-minted `job_id` is discarded and the existing run's id is returned**, per the `POST /compile` request-body correction above); a zombie run (stale `updated_at`, no `active_task_id`) recovered by the reconciler.
- **Staged-file ingest**: a batch with a mix of convertible files, one conversion failure (per-file isolation), one exact duplicate (dedupe skip), > `_STAGING_BATCH_SIZE` files (batch flush + incremental progress); assert exactly one compile-intent row at run end, staging cleanup after commit, and a `local`-backend vault failing loudly (`ValueError` → `failed` event).
- **SSE protocol fixtures**: a full compile streamed end-to-end (event order `connected` → snapshots → `done`); a reconnect mid-compile (fresh snapshot-first frame); connecting to an already-terminal job (one-shot snapshot + `done`); a heartbeat gap (30s idle comment frame); a `phase:""` pre-first-progress snapshot (frontend drops it silently — pin whichever behavior the TS port chooses); failed and cancelled terminal shapes.
- **Lint/cost fixtures**: an orphan article (zero inbound backlinks), a dirty topic (`rendered_from_hash != compiled_from_hash` — seed by editing a source and recompiling with render cache pinned, or direct row update), an unmentioned `topic_links` edge (topic links to a target its prose never cites); `llm_cost_events` rows across two vaults and two users to exercise both `GET /costs` aggregations (`by_vault`/`by_event_type` breakdowns, `since`/`until` windowing).
- **Progress-steps goldens**: recorded `progress_steps` JSONB snapshots per phase transition, asserting the exact key/label/status/done/total sequences in the taxonomy table above — the pipeline UI is the oracle per the M4 rules.
- **Render cache-repair and drift fixtures**: (a) a cache-hit topic whose `wiki/{slug}.md` file is missing from storage — exercises the `to_materialize` path (`render.py:167-201`), replaying the cached `{body, tags}` payload straight to storage with **zero LLM calls**, and asserts the file-repair "heals deleted files" behavior; (b) a cached render value seeded to fail `_RenderOutput.model_validate` (a schema-drifted `compile_cache` row) — exercises the `cache_invalid` branch (`render.py:192-197`), which must fall through to a real `to_render` LLM call rather than erroring or silently reusing the invalid payload.
- **Extract embed-batch timeout-skip**: a cassette/mock that times out one embedding batch inside `_embed_in_batches` (`extract.py:602-613`) — asserts the batch is silently skipped (not retried, not failed within this compile), the affected ideas remain unembedded this run, and a subsequent compile's cache-hit path (`existing_idea_ids` re-check, `extract.py:176-177`) picks them up and embeds them without re-running the LLM extraction call for that doc.
- **Extract body-validation rejections**: an LLM response that fails `SourceCard`/`Idea` pydantic validation inside `_validate_extract_output` (surfacing in `_extract_one` as a caught `ValidationError` → `schema_invalid:...`, `extract.py:349-351`) — asserts per-document isolation: the doc is recorded as `_ExtractFailed`, `docs_failed` is incremented, and the phase continues over remaining documents rather than aborting the compile.

---

# Explicitly out of scope

- **`POST /jobs/url`** — inventoried and ported in M3 (M3 decision 7); listed in the jobs table only as a pointer.
- **All M1/M3 surface** (auth, vaults, wiki/doc/session reads, session writes, query SSE, ingest routes, proposals, source deletion) — already inventoried; nothing re-documented here.
- **The canonicalize/registry-stability redesign (`compile-v2`)** — explicitly a post-cutover workstream per the M4 non-goal; the known over-merge/registry-variance behavior is documented above for as-is porting, not for fixing.
- **`core/search`'s internals** (chunker, hybrid BM25+vector search, `rebuild_raw_index`/`rebuild_wiki_index` implementation detail, embedding call sites inside SearchService) — consumed by ingest/extract/render and documented at their boundaries here; the search module itself was inventoried for M1/M3's read paths and its indexing internals are ported alongside the phases that call it (M4.3/M4.4), with this doc's phase sections defining the observable contract (tables written, step emissions).
- **Effect cluster/workflow engine table DDL** — the TS engine's own migrations; M4.2's task, not an inventory item (constraint recorded: must not collide with alembic's tables).
- **Absurd internals** (queue schema, claim/retry mechanics beyond the two explicit config sites documented) — replaced at cutover; only the observable semantics (idempotency keys, step ledger, heartbeat/claim timeout, retry strategy constants) are contract.
- **Multi-instance reconciler/SSE scaling** (per-job NOTIFY channels, distributed reconciler) — flagged in oddities as future risks, not port requirements.

---

# Notes on what could not be fully determined from the code

- `PipelineProgressRunner.emit`/`.fail` behavior when the target run row was deleted mid-flight — designed silent no-op (rollback-and-return) confirmed from code (`pipeline_runs/service.py:163-186`), but no deletion path for `pipeline_runs` rows was found, so the race may be unreachable.
- Python `struct.pack("I", ...)` native-mode byte order on the deployment targets is little-endian in practice, but the hashing contract's endianness is inherited, not pinned — the TS port should pin little-endian and the M4.1 harness should assert cross-implementation hash equality on a fixture corpus before anything else.

## Decisions (2026-07-11)

1. **Zero-Python-changes exception (behavior-preserving)**: `settings.openrouter_api_base` added (default `https://openrouter.ai/api/v1`, env `OPENROUTER_API_BASE`) and both client constructors read it, so the M4.1 golden harness can point the unmodified pipeline at a recording/replay proxy. Prod behavior is unchanged unless the env var is set; only the harness sets it. This is the only Python change permitted during the port.
