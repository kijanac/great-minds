# Conversation reply settlement

## Scope

This is the first database-backed component of Stage 2B.2, built on the [history storage foundation](conversation-history-storage.md). It implements the result-freezing and publication boundary in `packages/server/src/conversation-history/settlement.ts`.

It is **not yet the live reply workflow**. Durable acceptance, acceptance-time mode capture, the one-live-operation constraint, workflow integration, and reconciliation still need to be connected. Existing session readers/writers remain on the legacy format. This component must not be pointed at legacy files as a conversion mechanism.

The [history contract](future-ideas/conversation-history-contract-and-migration.md) and [acceptance matrix](future-ideas/conversation-history-acceptance-matrix.md) remain the coordinated-cutover specification. Neither the schema migration nor these tests authorize a production data migration.

## Why `settling` exists

```text
running
  → persist the exact result and enter settling
  → commit that result to JSONL
  → update DB projections and enter completed / stopped / failed
```

`settling` means that the result has been decided but publication is unfinished. Storage failure must retain that result for delivery, not turn it into a generation failure or cause another model/tool invocation.

The finalizer has no model, tool, workflow-dispatch, Markdown-rendering, or checkpoint-deletion dependency. Its only dependencies are the database, conditional history store, and clock. Application wiring must preserve that separation: an operation already settling resumes publication, not generation.

## Stored state

| Field | Purpose |
| --- | --- |
| `replies.settlement` | Temporary JSONB containing the exact settlement waiting for publication, including its fixed timestamp, outcome, text, sources, retained context, and generation metadata |
| `sessions.history_seq` | Last confirmed JSONL prefix length |
| `sessions.history_sha256` | SHA-256 of that exact prefix, including line endings |

There is **one receipt per session**, stored as ordinary columns. There is no reply-level receipt or JSONB receipt column. PostgreSQL requires the sequence/hash pair to be either both absent or both present, with a positive JavaScript-safe sequence and a lowercase SHA-256 digest.

The temporary result is operation state, not another settled transcript. After history publication and DB completion, `replies.settlement` is cleared. Existing answer/source/status fields are updated as projections. Checkpoints and other operation records are not garbage-collected by this component.

A receipt is not an R2 ETag. ETags fence conditional writes; receipts detect missing acknowledged history. For example, losing the last complete JSONL record can leave a syntactically valid older file. The database's sequence/hash pair prevents that older prefix from silently being accepted as complete or appended over.

## Freeze boundary

`begin(replyId, result)` serializes on the session row and then the reply row. All coordinator transactions use that lock order and retain the original vault/session identity.

For a running reply with a confirmed history prefix, it:

1. Reads the committed stop flag while holding the reply lock.
2. Selects and stores the exact outcome, content, and timestamp.
3. Changes status to `settling` and advances the reply version in the same transaction.

A stop committed before this boundary wins. Stopped and failed results preserve committed live partial text and nonpending sources. Stopped context uses the existing cancelled-tool-message construction. Native completed inputs require prepared generation metadata and recorded context; the stored-payload decoder also rejects native completions missing either.

A subsequent `begin` does not replace an already frozen result, even if its caller supplies a different outcome or the clock has advanced. This is the operation's outcome-selection boundary, not a rule for resolving conflicting history records. A different payload already saved under the same history identity remains a hard conflict.

`begin` returns `true` when a pending frozen result exists and `false` for a missing or already terminal reply. An invalid pending payload or absent history receipt is an explicit error, not a repaired state.

Application progress and stop writes must continue to require `status = 'running'`. The component tests exercise that database predicate, but end-to-end producer fencing still belongs to workflow integration.

## Publication boundary

`publish(replyId)` reads the frozen payload and the session receipt together, then submits the exact settlement to the history store with that receipt. No DB transaction stays open over object-storage I/O.

A missing object, missing acknowledged tail, incompatible saved settlement, storage error, or conditional-write conflict leaves the operation settling. There is no inline retry loop.

After confirmed storage success, a DB transaction:

1. Locks the same session and reply, in that order.
2. Confirms that the frozen payload has not changed.
3. Verifies the latest session receipt against the committed history snapshot. It cannot move the receipt backwards or replace an incompatible prefix.
4. Updates the session's sequence/hash pair and the terminal reply projection together.
5. Clears the pending payload and external-step claim, and advances the reply version.

If the receipt advanced while I/O was in progress, publication can defer until a fresh read supplies a history snapshot that includes it. It does not overwrite the newer receipt.

A lost storage acknowledgement is recovered by semantic replay: the exact saved settlement is recognized without another physical history write. A DB rollback after the history write retains the frozen payload, allowing projection repair. A lost acknowledgement after the final DB commit is a terminal no-op on redelivery.

`publish` returns `true` only when it completes the terminal DB transition. It returns `false` when there is no longer a pending settlement. Its caller is responsible for terminal client publication and durable scheduling of remaining obligations.

## Tests and safe reproduction

```sh
pnpm test:history-settlement
```

The runner provisions a uniquely named Docker Compose project with PostgreSQL/pgvector, binds a random loopback port, applies migrations only to that new database, and runs the settlement and semantic-store suites. It overrides any ambient `DATABASE_URL`, supplies a separate `REPLY_HISTORY_TEST_DATABASE_URL`, clears provider API keys, and disables the live LLM smoke flag for the child test processes.

The integration fixture also checks the exact database name and the server-side `great_minds.test_purpose = 'reply-history'` marker before creating test data. Each case uses separate user/vault/reply identities and a temporary local storage root. Cleanup removes that case's user-owned rows and local files. The runner tears down its Docker project and volumes in `finally`; it does not reuse a developer or production database. Its health-check timings follow the existing repository PostgreSQL test fixture in `docker-compose.packages-test.yml`.

Additional Vitest file selectors can be supplied after the command; they replace the two default selectors. The same disposable database is passed to existing integration suites that use `DATABASE_URL`.

`reply-settlement.integration.test.ts` exercises real PostgreSQL transactions and the local conditional history adapter, with explicit faults at the storage and DB-acknowledgement boundaries. It covers all three outcomes, fixed result/time on redelivery, competing freezes, stop ordering, running-only update fencing, missing metadata, conflicting saved results, lost acknowledgements, rollback, receipt mismatch, and SQL constraints. The history-store suite separately checks that commits cannot recreate missing acknowledged histories or append over a known missing complete tail.

Verification checkpoint: **159 tests passed across 11 files**: 34 new PostgreSQL settlement cases, the five foundation suites (including four added receipt-protected commit cases), and the five existing session/migration/Markdown/storage regression suites. The disposable runner provisioned, migrated, tested, and removed its database and volumes successfully. Full root type checking, targeted lint, and whitespace checks also passed. The existing query and process-resume suites subsequently passed together in a second fresh disposable database: **41 passed, one live-provider smoke skipped**. Two all-suite invocations reached the external 300-second command limit and are not counted as passing runs. The verbose combined run showed query cases continuing to pass but taking roughly 15–17 seconds each after the early cases; the cause of that timing difference remains unverified. No production timeout was changed to accommodate it.

These are coordinator-level tests, including recreation of the coordinator after failures. They are not an end-to-end native-workflow restart test, a provider/tool invocation-count proof for the new workflow, live R2 verification, or a power-loss guarantee. The existing process-death storage tests cover the separate local replacement protocol.

## Remaining Stage 2B.2 work

- Persist and reconcile durable acceptance/admission before dispatch.
- Enforce one admitting/running/settling operation per conversation, checking idempotent replay before busy rejection.
- Separate application placement/default/revision and freeze effective reply mode at acceptance.
- Route completed, stopped, ordinary failed, and ambiguous-call outcomes from the live workflow through this coordinator.
- Fence all generation/progress paths and reconcile settling records even after workflow completion or death.
- Verify the integrated fault paths with explicit model/tool invocation counts.

Authorized snapshots/SSE, frontend state handling, explicit sharing/promotion projections, detached legacy conversion, and deployment fencing remain later cutover work. The current reply DTO still presents an internal `settling` row as nonterminal `running`; this is not the final client-facing finalization contract.
