# Durable operations

Great Minds uses one execution model for work that must survive the originating request or process: a durable product record is committed first, then an Effect workflow executes idempotent activities. Product tables are the user-visible source of truth and dispatch outbox. Effect's `cluster_*` journal is execution machinery, not a replacement for product state.

## Managed operations

| Operation | Product record / outbox | Workflow | Idempotency key |
| --- | --- | --- | --- |
| staged file ingest | `file_ingest_batches`, `file_ingest_files`, `pipeline_runs` | `StagedFileIngest` | pipeline run / batch ID |
| vault compile | `compile_intents`, `pipeline_runs` | `CompileTask` | compile intent ID |
| URL ingest | `url_ingest_requests`, `pipeline_runs` | `UrlIngest` | pipeline run ID |
| research reply | `replies` (`request`, status, snapshots, dispatch metadata, generation cursor/claim) | `ReplyGeneration` | reply ID |

Every acceptance path commits enough input to redispatch work before it asks the workflow engine to execute. Startup/periodic reconcilers enqueue accepted rows whose dispatch acknowledgement was lost. Repeated execution is safe because workflow idempotency keys are stable and activities use deterministic storage keys or guarded upserts.

## Boundaries

- Browser file transfer is not a workflow activity. The durable batch exists first; workflow execution begins only after every expected object has a trusted receipt.
- URL ingest has no browser-byte boundary. The API returns its persisted run immediately, while fetch, conversion, source persistence, and compile intent creation continue in `UrlIngest`.
- Reply generation persists the complete request before dispatch. Reply snapshots remain the SSE/read model. `ReplyGeneration` journals a compact cursor after separate prepare, model-attempt, tool-call, and finalize activities; the full model transcript and tool outputs live temporarily at `operations/replies/{replyId}.json` in vault object storage and are removed before terminal state is committed.
- Cancellation first commits terminal product state, then interrupts the workflow. Activities guard before side effects because interruption is cooperative.
- Large source bodies, uploads, provider transcripts, and tool outputs stay in object storage. Workflow payloads and journal results contain identifiers, cursors, and compact decisions rather than response bodies.

## Retry semantics

Engine replay resumes the same operation and idempotency key. A completed reply activity is replayed from the Effect journal, while an object-store checkpoint closes the crash window between an external response and the database cursor update. Before each model/tool call, the reply row atomically records its active cursor, kind, and invocation key. If the process disappears before that external response is checkpointed, the turn is deliberately treated as ambiguous and fails with **Reply interrupted before an external response could be saved. It was not retried automatically.** Great Minds never spends again or repeats a tool side effect merely because the process restarted.

A user-requested retry creates a new operation ID. In particular, retrying a failed URL run copies its persisted canonical URL into a new URL-ingest run; it does not start a generic vault compile.

## Work that remains outside workflows

Ordinary reads and single-database CRUD do not need workflow overhead. Local/R2 lifecycle cleanup remains an idempotent maintenance loop. Browser-only review, hashing, and exact-byte reselection remain client/transport concerns.

Cross-system mutations should be promoted to this model only when partial completion is not safely convergent. The main remaining audit target is source deletion: database graph removal followed by object deletion can leave a recoverable orphan or resurrectable file if storage deletion fails. Proposal approval and reference promotion are currently retry-safe through stable source IDs and upserts, but should be reevaluated if their product contract becomes asynchronous or cancellable.
