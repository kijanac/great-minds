# Durable operations

Great Minds commits durable product state before work that must survive the originating request or process. Multi-step operations then use Effect workflows with idempotent activities. A single idempotent cleanup side effect may instead use a persisted outbox and maintenance reconciler. Product tables own operation state and dispatch obligations; recorded conversation content is owned by native JSONL. Effect's `cluster_*` journal is execution machinery, not a replacement for either. [Conversation authority and cutover requirements](conversations.md) apply to coordinated data/API/web/worker changes.

## Managed operations

| Operation | Product record / outbox | Workflow | Idempotency key |
| --- | --- | --- | --- |
| staged file ingest | `file_ingest_batches`, `file_ingest_files`, `pipeline_runs` | `StagedFileIngest` | pipeline run / batch ID |
| vault compile | `compile_intents`, `pipeline_runs` | `CompileTask` | compile intent ID |
| URL ingest | `url_ingest_requests`, `pipeline_runs` | `UrlIngest` | pipeline run ID |
| research reply | `replies` (accepted request, status, progress, exact pending settlement, dispatch/cursor/claim), session history receipt | `ReplyGeneration` plus admission/settlement reconciler | reply ID |
| source deletion | retired `source_incarnations` | maintenance reconciler | incarnation ID |
| proposal review | `source_proposals` (accepted decision, `reviewed_at`, `completed_at`) | maintenance reconciler | proposal ID |

Every workflow acceptance path commits enough input to redispatch work before it asks the workflow engine to execute. Startup/periodic reconcilers enqueue accepted rows whose dispatch acknowledgement was lost. Repeated execution is safe because workflow idempotency keys are stable and activities use deterministic storage keys or guarded upserts.

## Boundaries

- Browser file transfer is not a workflow activity. The durable batch exists first; workflow execution begins only after every expected object has a trusted receipt.
- URL ingest has no browser-byte boundary. The API returns its persisted run immediately, while fetch, conversion, source persistence, and compile intent creation continue in `UrlIngest`.
- Reply generation uses the browser-minted reply ID as acceptance and workflow key. Create/retry reserves the exact request and mode, saves the native history attempt, and confirms the session receipt before dispatch. Settlement freezes the exact result before publishing JSONL and terminal DB projection. Replaying the same command retains identity; incompatible reuse conflicts. Session endpoints read/project content, change placement/default through Continue, and perform explicit promotion; they do not maintain a second transcript writer.
- `ReplyGeneration` journals compact prepare/model/tool/finalize decisions. Prepared context and execution state remain at `operations/replies/{replyId}.json`; settled context/tool activity is retained in canonical history for follow-ups. Terminal checkpoints are not currently garbage-collected.
- Compile cancellation commits terminal product state before workflow interruption. Reply Stop instead commits intent while admitting/running; freeze arbitrates that intent, and a later Stop cannot overwrite a frozen result. Activities guard before side effects because interruption is cooperative.
- Source deletion atomically retires the current incarnation while removing its search/source/idea/membership projections. Conditional storage cleanup runs best-effort immediately and through a startup/periodic reconciler. Storage failure leaves a pending obligation for that incarnation, not permission to rediscover it or erase a replacement. Deletion deliberately creates no compile intent; existing articles remain until a separately requested compile.
- Large source bodies, uploads, provider transcripts, and tool outputs stay in object storage. Workflow payloads and journal results contain identifiers, cursors, and compact decisions rather than response bodies.

## Source ownership

A public source ID survives deletion and re-import. Its private **incarnation** identifies one lifetime; ordinary updates and intentional live path moves retain it. `source_incarnations` stores the active lifetime and each retired cleanup obligation. Source markdown carries `source_id` and `source_incarnation`; the registry binds both identities to the current path.

URL/file acceptance and proposal creation save the admitted incarnation with the accepted operation. Engine replay resolves that same lifetime before fetching, reading, converting or publishing content. A registered live move can change the resolved path, but a deleted incarnation cannot acquire a replacement's authority. Immediate source creation and reference/session promotion likewise capture admission before content I/O. Closed or changed ownership returns `Conflict`, not a fresh admission. Historical operations with no saved admission require a new import or proposal rather than an inferred binding.

### Object writes and projections

Source bodies use version-conditional PUTs. An absent path is first reserved with an ID-only control, then reread; body publication always compares against an observed non-null object version. This prevents a delayed first body write from recreating content after deletion. An uncertain body-write acknowledgment is not retried blindly: replay can recognize the exact owned bytes and repair their registry projection without another PUT.

SQL transactions lock metadata only; object I/O stays outside them. Source projections require the captured incarnation, path and content hashes to remain current. Extraction reads through the same ownership boundary so replacement bytes cannot be cached under an old source snapshot. Valid extraction/render caches remain authoritative across recovery; caching precedes guarded materialization rather than depending on a successful object-write acknowledgment. Topic membership has a cascading idea foreign key, and derive admits only ideas still belonging to live sources while holding their source locks.

Discovery rejects retired content and preflights duplicate identities across both cached and freshly read files. Nonce-bearing live moves retain ownership; legacy unversioned content is reconciled conservatively. Raw search pruning is scoped to captured source ownership, not a global path deletion.

### Deletion and cleanup

Cleanup atomically replaces an owned body with an ID-only `deleted` control. This is **body erasure, not physical object removal**. The `great-minds-source-state-v1` control format contains only the public source ID, incarnation ID and `reserved`/`deleted` state. Ordinary raw reads and existence checks hide controls; lifecycle reads retain them for fencing. A listing alone does not establish a readable source.

Conditional PUT is the documented R2 capability used here; conditional DELETE is not assumed. A competing update makes cleanup remain pending, while bytes proven to belong to another incarnation are left intact. Each retired incarnation retains its own attempt count, last attempt and completion; a re-import never resets an older obligation. Before legacy cleanup, any live replacement must pass the current-source ownership check; unversioned content is stamped with its active incarnation. Missing or stale live evidence—including a managed source that has lost its incarnation header—defers cleanup instead of guessing.

Local content and conversation histories share one scoped conditional backend. The process owns a stable exclusive lock inode and completes started filesystem I/O before releasing it. Test history hooks decorate that existing store instead of opening a second writer on the same root.

### Introducing incarnation tracking

Before applying `20261020200007_source_lifetimes`, drain accepted source/compile work, finish uploads, resolve pending proposals, and establish that old unconditional writers—including outstanding remote I/O—are quiescent. The migration refuses pending/running pipelines, uploading/processing batches and pending proposals. These metadata gates do **not** establish workflow or remote-I/O quiescence; a terminal pipeline row, a SQL lock or an elapsed delay is insufficient. Old and incarnation-aware source writers must not run concurrently.

The forward migration preserves every recorded cleanup path, attempt and timestamp. Old completion moves to `legacy_completed_at`; separate completion tracks conditional reconciliation, including paths historically marked complete. Current registry rows receive distinct active legacy incarnations, even when a retired record shares their public ID or path. Old URL/file/proposal bindings remain null; unrecorded historical cycles and paths are not reconstructed. Only dangling topic memberships are removed before adding the cascading idea constraint.

### Personal references

New Reading Room imports write to immutable reference-UUID paths. A SQL-only per-user/canonical-URL acceptance transaction selects one reference; a losing concurrent import removes only its own unpublished object. Existing reference IDs, paths and shares are preserved. URL deduplication is separate from vault-source ownership and does not substitute for object-version fencing.

## Workflow engine

- `ClusterWorkflowEngine` runs in-process through `SingleRunner` against the application database. Effect migrates and owns its `cluster_*` journal tables separately from the Drizzle-managed product schema. Runner registration is kept in memory, so a replacement process replays the durable journal immediately instead of waiting for a stale runner lease. This is a single-process deployment shape; multiple runners would require revisiting runner storage.
- Activities do not use the engine's `WithTransaction` integration, which hung against the shared `@effect/sql-pg` client when it was evaluated. Each external effect is replay-safe instead (content-addressed staging, source-owned conditional writes, coalescing intents, stable workflow IDs), and a branch decision is journaled once so replay never recomputes it from rows written by an earlier attempt.
- Progress and failure updates only change `pending`/`running` runs, so late progress or cooperative teardown cannot overwrite `completed`, `failed` or `cancelled`. Zombie recovery fails a stale active run only when `cluster_messages` holds no matching workflow request; a run queued behind an unsatisfied compile intent is waiting, not a zombie.
- Cancellation commits the guarded `cancelled` state first, then calls `interruptUnsafe` on the in-process engine. The routed `Workflow.interrupt` client path can wait in sharding when no separate healthy runner exists.
- Only the production entrypoint (`main.ts`) composes the reconciler loops; HTTP-only roots used by tests never dispatch background work. Stable workflow idempotency keys deduplicated in `cluster_messages`, not row locks, prevent double dispatch across reconciler passes and processes.
- Job progress streams poll the run row and send only changed snapshots, with comment heartbeats every 30 seconds.

## Retry semantics

Engine replay resumes the same operation and idempotency key. A completed reply activity is replayed from the Effect journal, while an object-store checkpoint closes the crash window between an external response and the database cursor update. Before each model/tool call, the reply row atomically records its active cursor, kind, and invocation key. If the process disappears before that external response is checkpointed, the turn is deliberately treated as ambiguous and fails with **Reply interrupted before an external response could be saved. It was not retried automatically.** Great Minds never spends again or repeats a tool side effect merely because the process restarted.

A user-requested retry creates a new operation ID. Retrying a failed research reply uses a new browser-minted reply ID with the persisted request and the same visible session position; repeating that acceptance is safe. The browser retains both previous and replacement IDs across a lost acknowledgment, even if the replacement has already finished. Retrying a failed URL run copies its persisted canonical URL into a new URL-ingest run; it does not start a generic vault compile.

Provider acceptance is not permission to invoke a fallback after a stream stall or a successful response with no body. Those observed failures settle the reply as `generation_failed`, retain committed partial content, and require explicit generation retry. A previously committed Stop still wins. Confirmed 429 rejection retains fallback behavior; this is distinct from ambiguous-call recovery, which uses `external_outcome_unknown`.

Reply requests nest new-session details or an existing session ID under `session`. A new BTW is its own conversation with a document/answer origin, not an optional branch embedded in an existing-session command. Accepted replies always belong to a session. Retry retains the exchange ID and original context parent, but freezes the current future-reply default. The public command no longer controls mode. Saved origin/annotation/cutoff and retained messages supply follow-up context independently of whether the current HTTP request creates a session.

Admission and frozen settlement obligations are reconciled independently of workflow liveness. An absent workflow can be redispatched under the same key; a completed workflow cannot cause another provider call merely to finish publication. Scans use bounded pages and a captured high-water position to revisit old obligations even as new replies arrive.

## Work that remains outside workflows

Ordinary reads and single-database CRUD do not need workflow overhead. Local/R2 lifecycle cleanup—including retired source incarnations—remains an idempotent maintenance loop. Browser-only review, hashing, and exact-byte reselection remain client/transport concerns.

Cross-system mutations should be promoted to workflows only when partial completion is not safely convergent through a small persisted outbox and idempotent side effect. Proposal approval and reference promotion use stable source IDs and captured incarnations for publication ownership. Reevaluate workflow ownership if these product contracts become asynchronous or cancellable.

### Proposal review

A review decision is accepted by one conditional status update from `PENDING` that also records `reviewed_at`; a concurrent or repeated review conflicts. The same transaction retains the proposal's saved incarnation, and a deletion approval retires it there, so the decision and its registry effect commit together. Everything that needs object I/O runs afterwards and is idempotent: publishing the staged content through the captured admission, ensuring a compile intent, erasing the retired body, and removing the staged object for rejections and deletion approvals. `completed_at` records that these effects finished; the request finishes them inline and a periodic reconciler finishes any accepted decision whose request died first. An approval whose saved incarnation has already been retired completes without publishing, because the lifetime it was admitted to no longer exists. The public status is the accepted decision, never an intermediate state, and it never changes to the other decision.
