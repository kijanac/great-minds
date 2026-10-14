# Durable operations

Great Minds commits durable product state before work that must survive the originating request or process. Multi-step operations then use Effect workflows with idempotent activities. A single idempotent cleanup side effect may instead use a persisted outbox and maintenance reconciler. Product tables own operation state and dispatch obligations; recorded conversation content is owned by native JSONL. Effect's `cluster_*` journal is execution machinery, not a replacement for either. [Conversation authority and cutover requirements](conversations.md) apply to coordinated data/API/web/worker changes.

## Managed operations

| Operation | Product record / outbox | Workflow | Idempotency key |
| --- | --- | --- | --- |
| staged file ingest | `file_ingest_batches`, `file_ingest_files`, `pipeline_runs` | `StagedFileIngest` | pipeline run / batch ID |
| vault compile | `compile_intents`, `pipeline_runs` | `CompileTask` | compile intent ID |
| URL ingest | `url_ingest_requests`, `pipeline_runs` | `UrlIngest` | pipeline run ID |
| research reply | `replies` (accepted request, status, progress, exact pending settlement, dispatch/cursor/claim), session history receipt | `ReplyGeneration` plus admission/settlement reconciler | reply ID |
| source deletion | `source_deletion_outbox` | maintenance reconciler | source ID |

Every workflow acceptance path commits enough input to redispatch work before it asks the workflow engine to execute. Startup/periodic reconcilers enqueue accepted rows whose dispatch acknowledgement was lost. Repeated execution is safe because workflow idempotency keys are stable and activities use deterministic storage keys or guarded upserts.

## Boundaries

- Browser file transfer is not a workflow activity. The durable batch exists first; workflow execution begins only after every expected object has a trusted receipt.
- URL ingest has no browser-byte boundary. The API returns its persisted run immediately, while fetch, conversion, source persistence, and compile intent creation continue in `UrlIngest`.
- Reply generation uses the browser-minted reply ID as acceptance and workflow key. Create/retry reserves the exact request and mode, saves the native history attempt, and confirms the session receipt before dispatch. Settlement freezes the exact result before publishing JSONL and terminal DB projection. Replaying the same command retains identity; incompatible reuse conflicts. Session endpoints read/project content, change placement/default through Continue, and perform explicit promotion; they do not maintain a second transcript writer.
- `ReplyGeneration` journals compact prepare/model/tool/finalize decisions. Prepared context and execution state remain at `operations/replies/{replyId}.json`; settled context/tool activity is retained in canonical history for follow-ups. Terminal checkpoints are not currently garbage-collected.
- Compile cancellation commits terminal product state before workflow interruption. Reply Stop instead commits intent while admitting/running; freeze arbitrates that intent, and a later Stop cannot overwrite a frozen result. Activities guard before side effects because interruption is cooperative.
- Source deletion atomically records the source ID, vault, and storage path while removing the database graph. The object delete is idempotent and runs best-effort immediately; a startup/periodic reconciler repeats any unfinished cleanup. Storage failure therefore leaves an operator-visible outbox row rather than failing or resurrecting the user-visible deletion. Deletion deliberately creates no compile intent.
- Large source bodies, uploads, provider transcripts, and tool outputs stay in object storage. Workflow payloads and journal results contain identifiers, cursors, and compact decisions rather than response bodies.

## Retry semantics

Engine replay resumes the same operation and idempotency key. A completed reply activity is replayed from the Effect journal, while an object-store checkpoint closes the crash window between an external response and the database cursor update. Before each model/tool call, the reply row atomically records its active cursor, kind, and invocation key. If the process disappears before that external response is checkpointed, the turn is deliberately treated as ambiguous and fails with **Reply interrupted before an external response could be saved. It was not retried automatically.** Great Minds never spends again or repeats a tool side effect merely because the process restarted.

A user-requested retry creates a new operation ID. Retrying a failed research reply uses a new browser-minted reply ID with the persisted request and the same visible session position; repeating that acceptance is safe. The browser retains both previous and replacement IDs across a lost acknowledgment, even if the replacement has already finished. Retrying a failed URL run copies its persisted canonical URL into a new URL-ingest run; it does not start a generic vault compile.

Provider acceptance is not permission to invoke a fallback after a stream stall or a successful response with no body. Those observed failures settle the reply as `generation_failed`, retain committed partial content, and require explicit generation retry. A previously committed Stop still wins. Confirmed 429 rejection retains fallback behavior; this is distinct from ambiguous-call recovery, which uses `external_outcome_unknown`.

Reply requests nest new-session details or an existing session ID under `session`. A new BTW is its own conversation with a document/answer origin, not an optional branch embedded in an existing-session command. Accepted replies always belong to a session. Retry retains the exchange ID and original context parent, but freezes the current future-reply default. The public command no longer controls mode. Saved origin/annotation/cutoff and retained messages supply follow-up context independently of whether the current HTTP request creates a session.

Admission and frozen settlement obligations are reconciled independently of workflow liveness. An absent workflow can be redispatched under the same key; a completed workflow cannot cause another provider call merely to finish publication. Scans use bounded pages and a captured high-water position to revisit old obligations even as new replies arrive.

## Work that remains outside workflows

Ordinary reads and single-database CRUD do not need workflow overhead. Local/R2 lifecycle cleanup—including the source-deletion outbox—remains an idempotent maintenance loop. Browser-only review, hashing, and exact-byte reselection remain client/transport concerns.

Cross-system mutations should be promoted to workflows only when partial completion is not safely convergent through a small persisted outbox and idempotent side effect. Proposal approval and reference promotion are currently retry-safe through stable source IDs and upserts, but should be reevaluated if their product contract becomes asynchronous or cancellable.
