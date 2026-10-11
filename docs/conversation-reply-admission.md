# Durable reply admission

This is the native admission component of Stage 2B.2. It works with the
[history store](conversation-history-storage.md) and
[settlement coordinator](conversation-reply-settlement.md). The
[workflow integration](conversation-workflow-integration.md) now connects it to
the application's create/retry, preparation, dispatch, and reconciliation paths.
This describes the repository implementation, not a deployed production cutover.

**Do not deploy this migration independently of the coordinated writer cutover.**
The previous acceptance path wrote legacy history before inserting its reply row.
Adding the one-live-reply constraint does not make an old process safe: old writers
must be stopped and fenced, not left to discover conflicts after writing. Existing
live operations must also be inventoried and resolved before installing the unique
index. The migration deliberately fails rather than choosing which duplicate
operation to discard.

## The two durable steps

`packages/server/src/conversation-history/admission.ts` implements:

```text
validated command + authorized conversation
  → DB reservation: exact command, acceptance descriptor, status admitting
  → conditional history commit: header if new, then accepted attempt
  → DB admission: session receipt, status running
  → dispatch by the caller
```

`reserve` performs the first step without writing history. `admit` delivers the
stored descriptor and confirms the history receipt. `accept` runs both; it does
not return a normal acceptance response while its history write is unfinished.
`retry` selects a failed attempt, then uses the same reservation and admission
steps with a new reply identity.

There is no provider, tool, workflow engine, Markdown renderer, or retry loop in
this component. Dispatch and reconciliation remain separate application work.
An unsuccessful history write must not be translated into generation failure or
cause a replacement operation to be created.

## No additional JSONB column

The existing `replies.request` field holds a versioned native request envelope:

- The decoded original command, for idempotency and retry options.
- The effective mode chosen at reservation.
- A header only when this reservation creates the conversation.
- The exact attempt: reply/exchange identities, predecessor, context parent,
  literal question, and acceptance time.

This is an immutable operation descriptor, not a second editable transcript. The
recorded attempt and settled content are read from JSONL. Stored envelopes are
strictly decoded at their database boundary; typed commands are not repeatedly
decoded inside the coordinator.

The descriptor has **no receipt of its own**. The only persisted receipt remains
`sessions.history_seq` and `sessions.history_sha256`. The only newly introduced
JSONB column across admission and settlement remains the temporary
`replies.settlement` payload described in the settlement guide.

## Reservation, concurrency, and mode

Authorization and existing-request identity checks happen before any history
mutation. An exact replay precedes a busy rejection and the missing-provider
configuration check. A changed command using the same reply ID is a conflict.
A second user cannot take over a session through its creation idempotency key.

Existing history is read and checked against the session receipt **outside the
DB transaction**. Reservation then locks the session, rechecks request identity
and live operations, and checks that the acknowledged history revision has not
changed. A changed revision returns a conflict without inserting the new reply;
a fresh submission with the same request IDs can select the new parent. There
is no inline retry loop and no object-store I/O while holding a DB transaction.

A partial unique index on `(vault_id, session_id)` prevents multiple
`admitting`, `running`, or `settling` replies in a conversation. The session lock
provides the normal conflict path; the index is the database backstop. Separate
conversations can reserve concurrently.

Mode is frozen from `sessions.replyMode` while holding that same session lock.
Placement, future reply default, and revision now have separate app-state columns;
none is used to infer historical generation provenance. Continue takes the same
PostgreSQL row lock and atomically changes placement/default, so a later continue
cannot change an already reserved mode. The public create command no longer
accepts a `mode` field in its declared contract. Preparation uses the saved
accepted mode, while explicit retry chooses the default at its new acceptance.

## Context and retry selection

Own-conversation parent selection uses the last selected, nonfailed settlement.
An accepted attempt does not fall back to an older successful attempt in the same
exchange after a newer attempt fails. A settled parent with missing retained
context blocks continuation instead of silently omitting its messages. An
unsettled own attempt with no live operation blocks new reservation for
reconciliation; a separate child conversation can still use an earlier settled
answer while its parent has a later reply running.

Retries preserve the exchange, original question/options, and original parent.
Only the selected failed attempt can gain a new successor. Replaying an already
accepted retry returns its original identity even when that retry now occupies
the live-operation slot.

For answer-origin conversations, the header fixes two distinct references:

- The selected settled reply in the annotated exchange.
- The latest usable inherited context cutoff captured for the new conversation.

The existing command supplies an exchange, so the annotation reply is selected
at acceptance. Subsequent parent-conversation activity does not retarget either
saved reference. Owner checks and the existing nested-BTW restriction apply
before private history is read or a child is reserved.

## Admission and failure recovery

Admission reads the stored descriptor and commits it at the same session JSONL
path, using the current session receipt. A new conversation's header and first
attempt are one history commit. Follow-ups cannot recreate missing acknowledged
history.

After storage succeeds, a short transaction locks the session and then the
reply. It verifies that the frozen descriptor is unchanged and that the latest
session receipt is covered by the saved history snapshot. It then advances the
session receipt and changes `admitting` to `running` together. A receipt that
advanced beyond this snapshot is not overwritten. If an operation is still
`admitting` but its settlement is already in history, admission reports an
integrity/reconciliation error rather than making it runnable for generation.
If another coordinator has already admitted and settled it, redelivery remains a
no-op instead. A deleted reservation does not receive a normal acceptance response.

The recovery obligations are deliberately small:

| Failure boundary | Durable state | Redelivery |
| --- | --- | --- |
| Reservation transaction rolls back | No new session/reply/history | Same command can reserve afresh |
| Reservation commits but acknowledgement is lost | Exact `admitting` request | Replay finds the same reply/session IDs |
| History unavailable or conditional write conflicts | Same `admitting` request | Retry admission; do not invoke generation |
| History saved but acknowledgement is lost | History may contain the exact attempt | Semantic replay recognizes it without another physical write |
| Admission DB transaction rolls back | History saved, reply still `admitting` | Repair receipt/status from the same descriptor |
| Admission DB acknowledgement is lost | Reply already `running` | No repeated transition/version increment |

A stop flag already committed on an admitting row survives admission. Settlement
will not freeze a result until admission is confirmed. The workflow now uses
these transitions for stop, dispatch, producer fencing, and reconciliation; see
the integration guide for the tested boundaries and outstanding release gates.

## Verification and remaining integration

The reproducible command is:

```sh
pnpm test:history-settlement
```

Its default selection includes admission, settlement, and receipt-protected store
tests. The shared fixture requires the explicit loopback test URL, exact
disposable database name, and server-side purpose marker before mutation. The
runner provisions and tears down its own PostgreSQL/pgvector project and disables
live providers.

Admission component checkpoint (`77b417e`): **210 tests passed across 12 files**, including **51
admission cases**, 34 settlement cases, and 125 history/storage/existing session
regressions. The runner applied the staged migrations only to its disposable DB
and removed its container, network, and volumes after the run. Root type checking
also passed. A separate fresh disposable run of the existing query and
process-resume suites passed **41 tests, with one live-provider smoke skipped**.
Together these are **251 distinct passing tests across 14 files**, not one
all-in-one suite run.

The first query/process-resume invocation exceeded its external 300-second
command limit. A rerun with a 900-second command allowance completed in 499
seconds, including provisioning and cleanup. Query cases again showed roughly
15-second delays with Effect cluster `No healthy runners available` warnings;
the cause remains unverified. No production timeout was changed. All owned
disposable containers and networks were removed.

The admission suite exercises real PostgreSQL transactions and local conditional
history with injected storage/DB failures and controlled concurrency. It checks
mode ordering with real session locks, not sleeps. These are component tests, not
proof by themselves that workflow wiring or process recovery works. Subsequent
[integration evidence](conversation-workflow-integration.md#tooling-and-verification)
covers native readers/writers, mode ordering, provider/tool invocation counts,
private disclosure, and actual process death.

The full authorized snapshot/active overlay, typed unavailable states,
deterministic offline conversion, and coordinated deployment rehearsal remain
release work under the wider
[contract](future-ideas/conversation-history-contract-and-migration.md). No
production data or migration has been changed by this implementation work.
