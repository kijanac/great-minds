# Spike Zero Report: Effect v4 / Drizzle v1 RC Posture A

Date: 2026-07-09

Branch note: the requested `spike/effect-v4-stack` branch could not be created in this sandbox because `.git` is read-only (`git switch -c ...` failed creating `.git/index.lock`). Work was performed as uncommitted working-tree changes on `main`. No push was attempted.

## Verdict

**Round 1 recommendation (superseded by Round 2, below): fall back to posture B.**

Posture A is not viable yet as the production migration posture. The Drizzle v1 RC + `drizzle-orm/effect-postgres` + pgvector path works, but the full modern stack does not satisfy Spike Zero: the requested coordinated `@effect/ai` v4 beta package is not published, the official v4 workflow/cluster packages are not published as package-level integrations, OpenRouter streaming could not complete with the repo key, and pnpm's release-age policy fights the exact fresh beta pins needed for posture A.

## Pass Criteria

| Criterion | Verdict | Evidence |
|---|---:|---|
| SSE streams tokens incrementally through the Node adapter; client disconnect interrupts the server fiber | **FAIL / PARTIAL** | A real client observed initial SSE bytes at `40-44ms`, but the real OpenRouter stream failed before token deltas because the provider returned 401. Client abort did interrupt the server fiber. Evidence: `[client] chunk=1 at=40ms bytes=13`, `[client] aborting stream`, server log `[sse] client closed connection; interrupting server fiber` then `[sse] server fiber interrupted after client disconnect`. Full stream attempt returned `event: error` after `230ms`; server logged `AuthenticationError`, `InvalidKey`, HTTP body `User not found.` |
| Tool-calling loop completes with typed parts; OpenRouter `cost` lands as a typed field | **FAIL** | The loop was implemented with the official `@effect/ai-openrouter` v4 beta client and a tool definition, but it did not complete because OpenRouter rejected the key. Also, the typed streaming usage object exposed token counts but no typed `cost` field in the observed API shape, so the scaffold emits `costUsd: null` rather than claiming a typed cost. |
| pgvector ANN query returns correct neighbors against predecessor-created tables; generated DDL is reviewable and correct for vector/tsvector/partial-unique | **PASS** | Docker Postgres with pgvector ran on localhost port `55433`; the predecessor migrator applied revisions `0001` through `0006`. ANN command output: `[ann] order synthetic/near.md > synthetic/mid.md > synthetic/far.md` and `[ann] decoded search_index row synthetic/near.md 1024`. `drizzle-kit generate` emitted `vector(1024)`, `tsvector`, `USING gin ("tsv")`, `USING hnsw ("embedding" vector_cosine_ops)`, and partial index `WHERE "render_run_id" IS NOT NULL`. |
| Workflow resumes from checkpoint after process kill, single-node topology, no extra infra beyond Postgres | **PARTIAL** | The behavioral durability proof passed with a single Node process plus Postgres: first run saved `prepare`, SIGKILLed, restart loaded `prepare_done=true`, skipped the first step, and completed. It is partial because this uses a custom checkpoint table with Effect fibers and `@effect/sql-pg`, not official Effect workflow/cluster APIs. |
| Pinned beta set installs and typechecks cleanly under TS 7/tsgo; scaffold-to-green without fighting >2 upstream bugs | **PARTIAL / FAIL** | `npm run typecheck` passed with tsgo across `packages/domain`, `packages/database`, and `packages/server`. However, local Node is `v26.3.0`, not Node 24; pnpm's `minimumReleaseAge` policy rejects fresh beta packages unless install is run with `--config.minimum-release-age=0`; `@effect/ai` v4 beta and v4 package-level workflow/cluster integrations were unavailable. |

## Scope Coverage

1. **Monorepo scaffold:** implemented `packages/domain`, `packages/database`, `packages/server`; added root typecheck through tsgo.
2. **Auth slice:** implemented email-code request stub, verify stub issuing JWTs, and authenticated `/auth/me`. Verified `/auth/me` returned `200` with a validated user JSON body after fixing the UUID schema.
3. **SSE + OpenRouter:** implemented SSE route and client harness, plus a real `@effect/ai-openrouter` streaming tool loop. Provider auth blocked the actual token/tool proof.
4. **Drizzle + pgvector:** implemented table definitions for `users`, `vaults`, `pipeline_runs`, `search_index`, `topics`, and `wiki_articles`; generated SQL; ran ANN through `drizzle-orm/effect-postgres` and decoded a row through `drizzle-orm/effect-schema`.
5. **Workflow durability:** implemented and verified checkpoint/resume behavior, but not through official Effect workflow/cluster.

## Exact Pinned Version Set

Posture-A pins installed in the workspace:

| Package | Version |
|---|---:|
| `effect` | `4.0.0-beta.94` |
| `@effect/sql-pg` | `4.0.0-beta.94` |
| `@effect/platform-node` | `4.0.0-beta.94` |
| `@effect/ai-openrouter` | `4.0.0-beta.94` |
| `@effect/ai-openai-compat` | `4.0.0-beta.94` |
| `drizzle-orm` | `1.0.0-rc.4` |
| `drizzle-kit` | `1.0.0-rc.4` |
| `@effect/tsgo` | `0.16.3` |
| `@typescript/native-preview` | `7.0.0-dev.20260707.2` |
| `@types/node` | `26.1.1` |

Important version findings:

- `@effect/ai` is not installed because no coordinated `4.0.0-beta.N` package was available; the latest observed package line was `0.36.0` with Effect v3 peers.
- `@effect/workflow@4.0.0-beta.94` and `@effect/cluster@4.0.0-beta.94` were not available as package-level integrations. Effect v4 contains unstable cluster/workflow declarations under `effect/dist/unstable/...`, but this spike did not prove a production workflow stack on those internals.
- `drizzle-orm@1.0.0-rc.4` accepted Effect v4 beta peers, so no Effect beta step-down was required for Drizzle compatibility.
- Root `oxfmt` remains at the existing `^0.44.0`; it is not part of the spike stack.

## Command Evidence

Typecheck:

```text
> typecheck
> tsgo -p packages/domain/tsconfig.json --noEmit && tsgo -p packages/database/tsconfig.json --noEmit && tsgo -p packages/server/tsconfig.json --noEmit
```

Docker Postgres:

```text
gm-spike-zero-db-1   pgvector/pgvector:pg18   Up ... (healthy)   0.0.0.0:55433->5432/tcp
```

Predecessor migrations:

```text
Running upgrade  -> 0001, initial schema from SQLAlchemy models
Running upgrade 0001 -> 0002, wiki_articles.render_run_id
Running upgrade 0002 -> 0003, wiki_articles.archived
Running upgrade 0003 -> 0004, wiki_articles.tags
Running upgrade 0004 -> 0005, source proposals role metadata
Running upgrade 0005 -> 0006, sessions.idempotency_key
```

Drizzle generate:

```text
No config path provided, using default 'drizzle.config.ts'
Reading config file '/Users/kijana/Documents/Code/great_minds/drizzle.config.ts'
[✓] Your SQL migration ➜ packages/database/drizzle/20260709112410_broad_kate_bishop/migration.sql 🚀
```

ANN:

```text
[ann] order synthetic/near.md > synthetic/mid.md > synthetic/far.md
[ann] decoded search_index row synthetic/near.md 1024
```

Workflow kill/restart:

```text
[workflow] loaded id=spike-zero-report prepare_done=false finish_done=false
[workflow] step=prepare starting slow checkpointed work
[workflow] checkpoint saved step=prepare
[workflow] SIGKILL requested after first checkpoint
```

```text
[workflow] loaded id=spike-zero-report prepare_done=true finish_done=false
[workflow] resuming from checkpoint: step=prepare already complete
[workflow] step=finish starting
[workflow] checkpoint saved step=finish
[workflow] completed id=spike-zero-report
```

SSE full-stream attempt:

```text
[client] status=200
[client] chunk=1 at=44ms bytes=13
: connected

[client] chunk=2 at=230ms bytes=45
event: error
data: {"message":"SSE failed"}

[client] complete chunks=2
```

Server-side OpenRouter failure:

```text
[sse] server fiber failed {
  _tag: 'AiError',
  module: 'OpenRouterClient',
  method: 'createChatCompletionStream',
  reason: {
    _tag: 'AuthenticationError',
    kind: 'InvalidKey',
    http: { body: '{"error":{"message":"User not found.","code":401}}' }
  }
}
```

SSE client abort:

```text
[client] status=200
[client] chunk=1 at=40ms bytes=13
: connected

[client] aborting stream
[client] complete chunks=1
```

Server-side abort:

```text
[sse] client closed connection; interrupting server fiber
[sse] server fiber interrupted after client disconnect
```

## DDL Assessment

Generated DDL is reviewable and mostly correct for the modeled subset:

- `search_index.embedding` is emitted as `vector(1024)`.
- `search_index.tsv` is emitted as `tsvector`.
- `ix_search_index_tsv` is emitted as a GIN index.
- `ix_search_index_embedding` is emitted as HNSW with `vector_cosine_ops`.
- `ix_wiki_articles_render_run_id` is emitted with a semantically correct partial predicate.
- Unique constraints for `search_index(vault_id, path, chunk_index)` and `wiki_articles.topic_id` are emitted.

Expected differences from predecessor-created reality:

- Drizzle generated only the subset of tables modeled for the spike, not the full production schema.
- Drizzle did not emit `CREATE EXTENSION IF NOT EXISTS vector` or `pgcrypto`; the predecessor owned those at the time.
- Constraint names differed from the predecessor's names in several places.
- `progress_steps jsonb DEFAULT '[]' NOT NULL` is equivalent in Postgres to the predecessor's explicit JSONB default form.
- The retired queue schema was not applied because the custom workflow checkpoint proof did not need it.

## Upstream Bugs / Friction

| Severity | Friction | Workaround / Finding |
|---:|---|---|
| High | `@effect/ai` was requested at the same `4.0.0-beta.N` as Effect, but no v4 beta package was available. | Used `@effect/ai-openrouter` and `@effect/ai-openai-compat` v4 beta packages directly. This leaves the official posture-A LLM stack unproven. No issue link found in the time box. |
| High | Official v4 `@effect/workflow` / `@effect/cluster` package-level integrations were not available at beta.94. | Proved checkpoint behavior with custom SQL + Effect fibers only. This is not enough for posture A. No issue link found in the time box. |
| High | The repo `OPENROUTER_API_KEY` was present but OpenRouter returned 401 `User not found`. | Could not prove token deltas, tool completion, or cost extraction. Key value was not committed. |
| Medium | OpenRouter streaming usage type exposed token counts but not a typed `cost` field in the observed official client shape. | Scaffold emits `costUsd: null`; posture A fails the cost criterion unless another official typed part exists or a lower-level response includes cost. |
| Medium | Local runtime is Node `v26.3.0`, not requested Node 24, and Node 26 rejects `--experimental-transform-types`. | Used `--experimental-strip-types`. Node 24 was not available locally, so Node 24 compliance is unproven. |
| Medium | pnpm `minimumReleaseAge: 4320` conflicts with fresh beta/RC packages and can fail commands before typechecking. | Install required `CI=true pnpm install --no-frozen-lockfile --config.minimum-release-age=0 --ignore-scripts`; root `npm run typecheck` avoids pnpm's recursive dependency-status path. |
| Medium | `pnpm install` is noninteractive in this sandbox and initially aborted removing `node_modules`. | Use `CI=true`. `pnpm-workspace.yaml` now has explicit `allowBuilds` entries for build-script packages. |
| Low | The predecessor migration tool tried to use a sandbox-blocked user cache. | Used a writable temporary cache. |
| Low | Default spike DB port `55432` was occupied. | Used `55433`. |
| Process | The sandbox does not allow `.git` writes, so branch creation and commits were blocked. | Left work as uncommitted changes and recorded the limitation. |
| Process | While checking environment names, a broad `.env` search printed the OpenRouter secret in tool output. | The value was not written into repo files or this report. If tool logs are retained outside this local session, rotate the key. |

## Time / Effort Assessment

The beta stack fought the spike in material places. Drizzle v1 RC's Effect integration was the strongest piece: it installed, typechecked, produced sane pgvector SQL, queried the predecessor-created database, and decoded rows. The Effect v4 platform/AI/workflow side was much shakier: missing coordinated packages, unstable internal API surfaces, runtime flag mismatch, and provider auth prevented the real LLM proof.

I would not build the production port on posture A today. I would keep the scaffold and Drizzle definitions, then fall back to posture B's stable integration seams while preserving the option to revisit posture A after Effect 4 and Drizzle 1.0 stabilize together.

## Scaffold That Survives Posture B

- `packages/{domain,database,server}` workspace layout and source-export package shape.
- Root tsgo typecheck command and package-local `tsconfig.json` structure.
- Domain schemas for email-code auth/JWT boundary payloads, with minor adaptation if posture B pins Effect v3 Schema APIs.
- Drizzle table definitions for the modeled production subset, especially `search_index` vector/tsvector/index definitions.
- `drizzle.config.ts` and generated migration review workflow.
- `docker-compose.spike.yml` for scratch pgvector Postgres on a non-production database.
- ANN verification harness using synthetic vectors and the predecessor-created schema.
- Auth route shape and JWT smoke-test harness.
- SSE client abort/timing harness, even if the server implementation becomes a posture-B hand-rolled SSE seam.
- Workflow kill/restart evidence pattern, even though the implementation should switch to posture-B workflow/cluster packages or Absurd fallback.

## Round 2

Date: 2026-07-09 (same day, second pass). Round 1's central wrong assumption is corrected: on the Effect v4 line there are no separate `@effect/workflow@4.x` / `@effect/cluster@4.x` / `@effect/ai@4.x` packages. Those modules ship INSIDE `effect@4.0.0-beta.94` as `effect/unstable/workflow`, `effect/unstable/cluster`, and `effect/unstable/ai` (verified present in the installed package). `@effect/ai-openrouter@4.0.0-beta.94` is the provider layer for `effect/unstable/ai`. Round 1's "missing coordinated packages" friction rows were a packaging misread, not a gap in the v4 line.

### Round 2 verdicts

| Criterion | Verdict | Evidence |
|---|---:|---|
| Workflow resumes from checkpoint after process kill, single-node topology, official APIs, no infra beyond Postgres | **PASS** | `packages/server/src/workflow-official.ts` uses `Workflow.make` + `Activity.make` (`effect/unstable/workflow`) executed by `ClusterWorkflowEngine.layer` + `SingleRunner.layer` (`effect/unstable/cluster`) over `@effect/sql-pg`. One process, SIGKILLed mid-second-activity, restarted: the first activity did NOT re-execute, its persisted result flowed into the final output. Logs below. |
| SSE streams a real OpenRouter tool-calling loop: ≥1 tool round-trip, incremental token deltas client-side, completion; client disconnect interrupts the server fiber | **PASS** | Real key worked this round. Client observed `tool-call` + `tool-result` events at 891ms, then 19 incremental `delta` chunks from 2218ms to 2671ms with distinct arrival times (10–140ms gaps — genuine incremental delivery, no buffering), then `finish` with token usage. `--abort` run: server logged `client closed connection; interrupting server fiber` then `server fiber interrupted after client disconnect`. |
| OpenRouter `cost` lands as a typed field | **FAIL (typed) / reachable at runtime via a one-module raw seam** | No typed path exists at beta.94, and the one candidate typed accessor is broken against the live API. Cost IS on the wire and IS retrievable; details below. The spike loop now emits a real `costUsd` (`0.00002565`) in the SSE `finish` event via the raw generation-endpoint fallback. |

### Workflow durability evidence (official stack)

Topology: ShardManager-equivalent + Runner colocated in ONE process. `SingleRunner.layer` wires `Sharding`, no-op runner comms/health, and SQL-backed `MessageStorage` for a single-process cluster — the API does NOT force two processes. `runnerStorage: "memory"` was chosen so a SIGKILLed run leaves no stale SQL shard lock (default expiration 35s); durable workflow state stays in SQL message storage. `ShardingConfig` defaults worked zero-config.

Run 1 (`SPIKE_KILL_AFTER_CHECKPOINT=1`, DB `gm_spike` on port 55433):

```text
[official] requesting execution runId=spike-zero-report-r2 killDuringFinish=true
[official] workflow body start runId=spike-zero-report-r2 executionId=4adf88bb350f335395a3b4efbb78f20c
[official] activity=prepare executing (must only appear on the first run)
[official] activity=prepare complete; engine persists its result
[official] activity=finish executing
[official] SIGKILL now: prepare is checkpointed, finish is incomplete
```

Run 2 (restart, same `SPIKE_WORKFLOW_ID`):

```text
[official] requesting execution runId=spike-zero-report-r2 killDuringFinish=false
[official] workflow body start runId=spike-zero-report-r2 executionId=4adf88bb350f335395a3b4efbb78f20c
[official] activity=finish executing
[official] activity=finish complete
[official] workflow completed runId=spike-zero-report-r2 result=prepared+finished
```

Same deterministic `executionId` (derived from the workflow tag + `idempotencyKey`), no `activity=prepare executing` line on restart, and the final result `prepared+finished` contains the value produced only by the first run's `prepare` — i.e. replayed from Postgres, not recomputed. Resume latency after restart was a couple of seconds (`entityReplyPollInterval` 200ms defaults).

Storage footprint — the engine created exactly three tables in the scratch Postgres, nothing else:

```text
 public | cluster_messages   | table | great_minds
 public | cluster_replies    | table | great_minds
 public | cluster_migrations | table | great_minds
```

Caveat: this round ran against a freshly created `gm_spike` volume without the predecessor schema applied (round 1's ANN evidence used the predecessor-created schema); coexistence of `cluster_*` tables with the production schema is unexercised but they are plain prefixed tables.

### SSE / tool-loop evidence

Full stream through `/query/stream` (`sse-client.ts` harness, `openai/gpt-4o-mini`, ~110 total tokens):

```text
[client] chunk=1 at=44ms bytes=13      : connected
[client] chunk=2 at=891ms   event: tool-call   {"type":"tool-call","name":"lookup_spike_context"}
[client] chunk=5 at=892ms   event: tool-result {"type":"tool-result","name":"lookup_spike_context",...}
[client] chunk=7 at=2218ms  {"type":"delta","text":"The"}
[client] chunk=11 at=2231ms {"type":"delta","text":" verified"}
[client] chunk=19 at=2315ms {"type":"delta","text":" emphasizes"}
[client] chunk=31 at=2580ms {"type":"delta","text":" brief"}
[client] chunk=43 at=2671ms {"type":"delta","text":"."}
[client] chunk=45           {"type":"finish","promptTokens":91,"completionTokens":20,"totalTokens":111,"costUsd":0.00002565}
[client] complete chunks=45
```

Client abort mid-stream:

```text
[client] aborting stream
[client] complete chunks=1
[sse] client closed connection; interrupting server fiber
[sse] server fiber interrupted after client disconnect
```

Round 1's 401 was a key problem, not a stack problem: with a valid `OPENROUTER_API_KEY` the official `@effect/ai-openrouter` beta.94 streaming client completed the two-turn tool loop unchanged. Note: the loop uses the raw `OpenRouterClient.createChatCompletionStream` seam through the spike's hand-rolled SSE route; the `HttpApiSchema.StreamSse` endpoint schema is defined but full HttpApi handler wiring remains unexercised.

### Cost extraction findings (precise)

Where per-call cost lives in `@effect/ai-openrouter@4.0.0-beta.94`, established by reading the installed source and runtime probes:

1. **Typed streaming usage has no cost field.** `Generated.ChatGenerationTokenUsage` = `{completion_tokens, prompt_tokens, total_tokens, completion_tokens_details?, prompt_tokens_details?}`. No `cost`, no `cost_details`.
2. **The raw wire DOES carry cost** when the request includes OpenRouter's usage-accounting extension `usage: {include: true}`. Raw curl of `/chat/completions` (stream) final chunk: `"usage":{...,"cost":0.00000435,"cost_details":{"upstream_inference_cost":...}}`. The client always sets `stream_options.include_usage: true` (hardcoded in `createChatCompletionStream`) — that alone yields token counts only; `usage: {include: true}` must additionally be passed in the payload for cost. It passes through because the request body is sent via `HttpBody.jsonUnsafe` with no request-side schema validation.
3. **The typed client strips cost at decode.** Stream chunks are schema-decoded (`Schema.fromJsonString(Generated.ChatStreamingResponseChunk.fields.data)`), and v4 Schema struct decoding drops excess keys. Verified at runtime: with `usage: {include: true}` sent, the decoded final usage object logged by the server contains only the typed token fields — no `cost`. So cost is NOT an untyped passthrough reachable at runtime through the typed streaming client.
4. **The high-level `OpenRouterLanguageModel` doesn't help**: its finish part's `metadata.openrouter.usage` forwards the same already-decoded (stripped) usage object.
5. **A typed follow-up accessor exists but is broken.** `client.client.getGeneration` returns `GetGeneration200` with typed `data.total_cost: Schema.Number` — but decoding FAILS with `SchemaError` against real responses: the live API returns null for 16 fields the generated schema types as non-nullable (`app_id`, `cache_discount`, `external_user`, `moderation_latency`, `native_tokens_completion_images`, `router`, ...). Verified with a direct probe against an existing generation record.
6. **Working path (implemented in the spike loop):** raw `GET /v1/generation?id=<chunk.id>` through `effect/unstable/http` with a minimal local schema (`{data: {total_cost: number}}`), retried — the generation record is indexed asynchronously with variable latency (observed 2s to >5s; one run needed ~8s). The loop's `finish` SSE event then carried `costUsd: 0.00002565`, matching stream-side accounting.

```text
[loop] decoded final usage object: {"completion_tokens":20,"prompt_tokens":91,"total_tokens":111,...}   <- no cost after schema decode
[loop] cost from decoded stream usage: null
[loop] falling back to generation endpoint id=gen-1783599917-scMUI9uOLpPuRxsoREgf
[loop] generation endpoint total_cost: 0.00002565
```

Net: the "cost lands as a typed field" criterion fails at beta.94 on upstream schema drift (two OpenAPI-generated schemas out of sync with OpenRouter's live API). It is a small, well-understood seam — either a ~25-line raw request module (as implemented) or an upstream fix to `ChatGenerationTokenUsage`/`GetGeneration200`. Nothing suggests the stable 0.x provider line (posture B's `@effect/ai-openrouter@0.11`) is generated from a fresher OpenAPI spec, so this gap is provider-schema drift, not a posture-A-specific weakness.

### Revised recommendation (both rounds)

**Posture A is viable. Adopt it.**

What is now proven, cumulatively:

- **DB layer (Round 1):** Drizzle v1 RC + `drizzle-orm/effect-postgres` + `drizzle-orm/effect-schema` + pgvector ANN against predecessor-created tables; reviewable DDL.
- **Durable workflows (Round 2):** the official `effect/unstable/workflow` + `effect/unstable/cluster` stack passes the exact Spike Zero topology test — checkpointed activities, SIGKILL/restart resume, single process, Postgres only. The Absurd fallback trigger ("if Effect workflow/cluster fails the topology test") does NOT fire.
- **LLM streaming (Round 2):** real OpenRouter tool-calling loop with typed streaming parts, incremental client-side delivery, and fiber interruption on disconnect, on the official beta.94 provider client.
- **Toolchain (Round 1+2):** the pinned beta set installs and typechecks under tsgo across all three packages.

What is still assumed rather than proven:

- Full `HttpApi` + `StreamSse` handler wiring (transport mechanics proven on a raw Node route; the HttpApi endpoint schema typechecks but is not served).
- Node 24 LTS compliance (local runtime is Node 26.3.0; `--experimental-strip-types` used).
- Workflow engine breadth: retries, `DurableClock`, concurrent workflows, and coexistence of `cluster_*` tables with the production schema.
- Typed cost: requires the raw generation seam (or upstream schema fix) until `@effect/ai-openrouter` regenerates against OpenRouter's current API.

Round 1's fall-back-to-B verdict rested on three legs: "no coordinated v4 AI/workflow/cluster packages" (false — they live inside `effect` core), "OpenRouter 401" (key problem, since resolved), and "no typed cost" (real, but small, seam-sized, and posture-agnostic). With the first two legs gone, posture B's remaining advantage is API-line stability alone, against which posture A eliminates all three of posture B's hand-maintained seam modules and the scheduled v4 migration. Known risks that stand: the coupled Drizzle-RC↔Effect-beta cadence (mitigate with exact pins and batch upgrades), the `unstable/*` namespace churn on the workflow/cluster surface, and pnpm's `minimumReleaseAge` friction on fresh betas.
