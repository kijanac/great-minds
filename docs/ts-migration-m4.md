# M4 — Compile pipeline, workers, and durable workflows

**Parent plan:** `docs/ts-migration.md`. **House rules:** `docs/ts-migration-m1.md` (binding). **Prior art:** `SPIKE_REPORT.md` Round 2 (the proven single-node `ClusterWorkflowEngine` + `SingleRunner` durability pattern; the spike `workflow-*.ts` files are reference, then deleted here).

**Objective:** the TS backend runs the complete seven-phase compile pipeline and all worker tasks on Effect durable workflows, byte-faithful to Python where deterministic and statistically faithful where LLM-driven — completing the backend surface so M5 is only staging parity and cutover.

**Non-goal (hard rule):** NO algorithm changes. The canonicalize/registry-stability redesign (`compile-v2`, the confluence architecture) happens AFTER cutover as its own workstream — it must not tangle with this port. Where the current algorithm is known-imperfect (over-merge, registry variance), port it faithfully; the characterization harness pins today's behavior, not ideal behavior.

## Inventory prerequisite

`docs/api-contract-m4.md`, two parts:
1. **Remaining HTTP surface**: compile routes, job routes (incl. the job-progress SSE stream `use-job-sse.ts` consumes — protocol section with emit/parse citations, same rigor as M3's query stream), lint routes, cost routes — cross-checked against frontend consumers.
2. **Pipeline behavior inventory** (the bigger half): per phase (ingest, extract, abstract/{partition, premerge, canonicalize, synthesize, validate}, derive, render, verify, publish) — inputs/outputs, DB writes, storage artifacts, content-hash cache keys (`core/compile_cache/`), progress-step emissions (names/order per the recorded progress-steps taxonomy), LLM calls (which prompt, which model config, structured-output schemas), determinism classification per artifact (exact vs LLM-dependent). Plus: worker task semantics (`staged_file_ingest` incl. MarkItDown conversion — the M3.2 decision-13 binary-conversion deferral lands here; `compile_task` orchestration, retry/idempotency via Absurd today), compile-intents reconciler, pipeline-runs lifecycle, cancellation/retry semantics.

## Task breakdown (sequenced, review gate between each; Codex on gpt-5.6-sol — high reasoning for kernel tasks, medium for mechanical)

**M4.1 — Golden-compile characterization harness** (the M2 second half; BEFORE any pipeline port). Fixture corpus checked in; runs the PYTHON pipeline against a scratch stack to record goldens: exact artifacts (hashes, cache keys, partition assignments, DB rows, file trees) and statistical envelopes for LLM-dependent outputs (registry size bounds, membership distributions — seeded from the probe-findings methodology). Harness then replays against either backend. LLM calls for goldens: stub-recorded (cassette) so the harness is hermetic and free; one env-flagged live mode.
**M4.2 — Durable workflow foundation + workers.** Effect workflow/cluster engine layer in the server (spike pattern productionized, house rules); port `staged_file_ingest` (incl. full binary conversion — MarkItDown-equivalent; revisit the M3.2 conversion stack for pdf/docx or justify additions) and the compile-intents reconciler + pipeline-runs lifecycle. Absurd coexistence note: TS workflows REPLACE Absurd post-cutover; during M4, TS tasks enqueue/execute on the Effect engine while Python/Absurd remains prod — the queue-compat constraint from M3.2 dissolves at cutover (record the transition plan).
**M4.3 — Pipeline phases: deterministic spine.** ingest, publish, verify, derive + the compile_task orchestration workflow with progress-step emissions and the job SSE stream + compile/job/lint/cost HTTP routes. Characterization: exact-match against M4.1 goldens.
**M4.4 — Pipeline phases: LLM core.** extract, abstract (partition/premerge/canonicalize/synthesize/validate), render — faithful ports of prompts (drift guards), structured-output schemas, cache-key construction (exact), truncation/failure handling per the hardened Python behavior. Characterization: exact on cache keys/deterministic substeps, statistical on LLM outputs via M4.1 envelopes with recorded-cassette determinism in CI.
**M4.5 — Closeout**: full-pipeline golden run green both backends; browser smoke driving a real compile from ingest to published wiki on scratch data (live LLM, small corpus); punch list; docs.

## Rules (delta)

- Zero changes to `src/great_minds/`, `web/src/`, DDL (alembic still owns schema; the Effect cluster tables are created by the engine's own migrations — document where they land and confirm no collision with alembic's tables).
- The progress-steps taxonomy and job SSE protocol are contract (the pipeline UI is the oracle).
- Every LLM phase behind stub-recordable seams; no live LLM in CI.
- Faithful-port rule: where Python behavior is known-buggy, the M1 process rule applies (flag for decision, don't silently fix or replicate) — EXCEPT algorithmic quality issues (over-merge etc.), which are explicitly ported as-is per the non-goal.
