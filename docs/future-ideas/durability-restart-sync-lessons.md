# Durability lessons for restart and sync safety

> **Status:** exploratory proposal, not a verified decision. This note records lessons inspired by durable runtimes such as `pi-durable`; it does not recommend adopting any specific package directly.

## Core invariant

A useful invariant for Great Minds is:

> User-visible durable progress is published only after the state that explains it has committed.

In practice:

- no SSE frame should be the only record of progress;
- no partial reply token should be visible after reload unless it was committed;
- no compile phase should be considered accepted unless there is a durable run/intent row;
- no workflow journal should be the only source of product truth.

## Product state vs execution machinery

Product state should answer:

- What did the user ask for?
- What source/reply/session/compile exists?
- What status can the UI show after reconnect?
- What should be synced to another device?

Execution machinery should answer:

- Which process is working on it?
- Which phase is currently running?
- What retry/backoff/scheduler state exists?

Great Minds already has this principle in `docs/durable-operations.md`: product tables are the user-visible source of truth; workflow journals are execution machinery. The future local-first design should preserve and strengthen that boundary.

## Pattern: durable acceptance before work

For any operation that can survive the request/process:

1. Validate authorization and input.
2. Commit an acceptance record with complete input or stable pointers.
3. Return/stream from that durable record.
4. Dispatch workflow/task using a stable idempotency key.
5. Reconcile on startup if dispatch acknowledgement was lost.

Examples:

- staged file ingest: batch/file/run rows before processing;
- URL ingest: request/run row before fetch;
- reply generation: reply row/request/session event before model call;
- compile: compile intent/run before phase work;
- source deletion: DB deletion + deletion outbox before best-effort object cleanup.

## Pattern: external invocation records

External side effects need explicit invocation records.

Before calling an external system, commit:

```json
{
  "operation_id": "...",
  "phase": "model_attempt",
  "invocation_key": "...",
  "request_hash": "...",
  "provider": "...",
  "idempotency_key": "... if available",
  "started_at": "..."
}
```

Then call the external system. Then commit the response or a pointer to a checkpoint.

This narrows the crash window and makes restart behavior explicit.

## Ambiguous external responses

A key Great Minds policy worth preserving:

> Do not automatically spend again or repeat tool side effects merely because the process restarted after an ambiguous external call.

If the process crashes after sending a model/tool request but before saving the response, the system usually cannot know whether the provider acted. Safe options:

- If provider supports idempotency/retrieval, resume with the same idempotency key.
- If the operation is known replay-safe, retry.
- Otherwise fail with an explicit interrupted/ambiguous state and require user retry.

This is already important for replies. It likely applies to compile LLM calls as well.

## Pattern: derived state is rebuildable

Durability does not mean every derived index must be synced or recovered exactly. It means the user-visible source of truth can be recovered.

Canonical state should be enough to rebuild:

- search chunks
- embeddings/vector indexes
- topic relatedness projections
- article backlinks
- compile progress views

If a projection is expensive to rebuild, cache it; but design so losing it is not data loss.

## Pattern: outbox for small convergent side effects

Not every cross-system mutation needs a full workflow. A persisted outbox is enough when:

- the product state has already converged;
- the side effect is idempotent;
- failure can be retried by maintenance;
- user-visible state should not resurrect on failure.

Current source deletion is a good example: remove DB graph, record storage path in outbox, retry object deletion until done.

## Pattern: commit marker for sync

For encrypted sync, copy the same durability idea to remote object storage:

1. Upload encrypted data objects.
2. Upload signed commit object referencing data objects.
3. Advance head only after commit/object uploads are complete.
4. Treat compaction/GC as best-effort maintenance after a later durable marker authorizes it.

Never publish a head that points to objects that might not exist.

## Local durability vs sync durability

A local commit and a synced commit are different states.

Useful states:

```text
accepted locally
committed locally
objects encrypted
objects uploaded
commit uploaded
remote head advanced
pulled by another device
applied by another device
```

UX should distinguish:

- saved locally
- syncing
- synced
- conflict
- private/local-only
- failed to upload

## One writer or explicit merge

For one local store, prefer one writer:

- one local API process owns DB writes;
- multiple browser tabs proxy to one worker/runtime;
- background workers coordinate through the same durable store.

For multi-device sync, multiple writers are unavoidable. Therefore the remote format must be append-only and merge-aware, not a mutable shared DB file.

## Restart checklist for every long operation

For each workflow/task, define:

1. What row/object proves the operation was accepted?
2. What idempotency key identifies it?
3. What is the smallest durable checkpoint needed to resume?
4. Which phases are replay-safe?
5. Which external calls are ambiguous after crash?
6. Which side effects are idempotent?
7. What does the UI show after reload?
8. What can be cancelled, and where is cancellation committed?
9. What is synced to other devices?
10. What can be rebuilt locally?

## Applying this to current operations

### Replies

Strong current pattern:

- browser-minted reply ID as idempotency key;
- persisted request before dispatch;
- snapshots as read model;
- ambiguous external response fails explicitly rather than auto-retrying.

Future local-first concern:

- decide which sessions/replies sync across devices;
- encrypt checkpoints/transcripts;
- keep provider calls local/direct.

### Compiles

Current pattern:

- `compile_intents` and `pipeline_runs` are durable product records;
- `CompileTask` uses compile intent ID as idempotency key;
- reconciler dispatches pending intents;
- active compile cancellation is product-state-first then interrupt.

Potential hardening:

- persist requested-by/audit fields;
- snapshot source/config head at compile start;
- record external LLM invocation keys per phase;
- publish compile artifacts atomically against the base snapshot.

### Ingest

Current pattern:

- staged uploads separate browser file transfer from workflow execution;
- URL ingest creates durable run/request and continues asynchronously.

Future local-first concern:

- local file selection cannot be synced; sync the resulting canonical source object and metadata, not the browser `File` handle.

## Testing matrix

Durability claims should be tested with fault injection:

- kill process before dispatch acknowledgement;
- kill during external model call;
- kill after provider response before DB commit;
- kill during object write;
- kill during publish/head update;
- restart with duplicate reconciler attempts;
- cancel during each phase;
- corrupt/truncate checkpoint file;
- disk full/quota exceeded;
- concurrent tabs/devices submitting conflicting work.

## Open questions

- Should compile LLM calls adopt the same no-ambiguous-auto-retry rule as replies?
- Which current workflow journal details are safe to drop/rebuild locally?
- How much progress should be committed for high-frequency token streams?
- Should the local-first sync protocol include a generic operation log or domain-specific commits?
- How do we present local saved vs remotely synced in the UI?
