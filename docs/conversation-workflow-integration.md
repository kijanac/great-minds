# Native conversation workflow integration

## Status and release boundary

This implementation connects [admission](conversation-reply-admission.md), [settlement](conversation-reply-settlement.md), and [conditional history storage](conversation-history-storage.md) to the application's reply workflow. Native writers, the required private readers, public disclosure selection, API schemas, and browser hydration change together.

**This is an integration checkpoint, not a deployment-ready migration.** No production database, bucket, or deployment has been changed. Do not deploy the new schema, workers, API, or browser independently. Existing histories and saved requests need deterministic offline conversion; duplicate live operations need explicit resolution. The full authorized snapshot contract, migration rehearsal, backup/restore proof, and deployment fencing remain release gates in the [contract](future-ideas/conversation-history-contract-and-migration.md) and [acceptance matrix](future-ideas/conversation-history-acceptance-matrix.md).

## Authority stays divided by fact

| Store | Owns |
| --- | --- |
| Conversation JSONL | Accepted attempts, settled questions/answers/outcomes, visible tool activity, retained context for ordinary follow-ups, recorded generation metadata |
| PostgreSQL | Ownership and membership, placement and future reply default, idempotency, operation coordination, temporary exact settlement, one session receipt, application projections |
| Reply checkpoint | Prepared execution context, model/tool cursor and results needed to resume unfinished work |
| Markdown | Derived presentation only; an old or missing sidecar cannot change the recorded conversation |

The paths remain `vaults/<vault_id>/sessions/<session_id>.jsonl` and `vaults/<vault_id>/operations/replies/<reply_id>.json`. This is one evolved history, not a parallel transcript store. Whole-application recovery still needs the necessary database, object, and checkpoint state together. It is not JSONL-only restoration after losing the other stores.

`HistoryStore` is acquired through the application layer. The local backend owns its stable OS lock for that runtime's scope; R2 uses conditional object writes. Test fixture resets preserve `.conversation-history.lock` until the runtime closes. Old external writers and migration scripts must be stopped or fenced; an advisory lock does not protect against a writer that ignores it.

## Acceptance and application choices

The live create and retry handlers use the admission coordinator:

```text
reserve immutable request as admitting
  → save header/attempt against the history receipt
  → confirm receipt and running status
  → dispatch the same reply ID
```

Normal API acceptance requires confirmed history admission. A failed dispatch after admission leaves a durable runnable obligation; it does not ask the client to invent a replacement reply. Exact replay retains the accepted identity even when the operation is already live or provider configuration has disappeared.

The `conversation_app_state` migration replaces overloaded `sessions.kind` with:

- `placement`: `inline` or `standalone`.
- `reply_mode`: `btw` or `query`, for future acceptance.
- `revision`: incremented by an actual application-state transition.

Existing BTW rows backfill to inline/BTW; existing ordinary sessions backfill to standalone/query. The public `kind` remains a projection of placement. Continue locks the session, changes placement/default together, and increments revision once. Repeating or concurrently submitting Continue is a no-op after that transition. It does not replace the session, origin, or history.

Admission freezes `session.replyMode` under that same lock. Preparation reads the accepted envelope, not today's placement/default. A reply accepted before Continue remains BTW-mode even if it is prepared afterward; the next accepted reply uses query-mode. The public create request no longer has `mode`; the internal query execution request still does.

One unique live-operation slot covers admitting, running, and settling. Retries require a new reply ID, retain the original exchange/question/options/context parent, and choose the current default for the new attempt. Annotation identity and inherited context cutoff remain distinct immutable references.

## Generation and settlement

All completed, stopped, ordinary failed, and ambiguous-call outcomes use the same freeze/publication coordinator. Progress and external-step claims update only running rows. Stop records intent only while admitting or running; a stop after freeze cannot replace the frozen result.

A terminal model result is frozen before best-effort terminal checkpoint bookkeeping. Checkpoint or history publication trouble must not convert that decided result into a new generation attempt. The temporary settlement contains the exact retained messages and metadata needed to publish it; it is cleared only with terminal DB projection and receipt advancement.

Generation steps first check for an already recorded settlement. `restoreRecorded` can repair a stale running DB projection from receipt-verified history without rewriting history or honoring a later stop. The newest locked receipt is rechecked before projection, so a stale read cannot regress it. This is operation recovery, not read-triggered repair.

A saved terminal checkpoint is also handled before claiming another external step. An outstanding model/tool claim without a saved result remains ambiguous: recovery records a failure or committed stop rather than calling the provider/tool again. Absence of generation metadata is not treated as evidence that no call happened.

Generation metadata uses the prepared mode, `gm-prompt-v1` digest, first requested model, and known last selected model. That digest is the existing namespaced, length-prefixed prompt hash, not raw SHA-256 of prompt text and not a complete provider-call archive.

Cost recording remains separate, best-effort bookkeeping over execution state, with the existing idempotent cost insert. The ordinary successful path finalizes from the saved terminal checkpoint rather than doing the same cost lookup twice. Checkpoint garbage collection and a stronger accounting-recovery protocol are not added here.

## Reconciliation does not depend on workflow success

The periodic reconciler handles all live obligations:

| State | Action |
| --- | --- |
| Admitting | Deliver the stored admission descriptor, then dispatch only if runnable |
| Settling | Publish the frozen result; do not generate |
| Running, dispatch unconfirmed | Dispatch using the same workflow/reply key |
| Running, no workflow result | Idempotently redispatch; this also covers a missing execution |
| Running, suspended workflow | Request resumption; history/checkpoint/claim fences still apply |
| Running, completed workflow | Freeze its saved terminal checkpoint, or settle an interrupted/failed operation without generating a new answer |

A preparation failure that completed the workflow while history was unreadable remains an obligation. Once history is readable, reconciliation can record the failure; a fresh generation then requires the explicit retry operation. It does not silently turn a failed workflow into another provider request.

Each scan page is bounded by configured pipeline concurrency. A pass captures a high-water `(created_at, id)` position, so continuous new admissions cannot postpone revisiting older obligations forever. Failed rows stay in their durable state. There is no arbitrary inline retry budget or object I/O under a DB transaction.

## Required reader and consumer cutover

`src/sessions.ts` no longer decodes or writes legacy session records. It reads receipt-verified native histories and follows the frozen context chain across owned conversations. The immediate usable parent's tool results remain intact; older tool results retain the existing execution-context reduction. Missing retained context, missing acknowledged history, and cycles are not silently omitted.

`conversation-history/presentation.ts` projects selected attempts without exposing retained provider messages or generation internals. Exchange events now require reply identity, explicit status, and error; a historical unknown timestamp stays null. Browser hydration uses status rather than answer length. Completed-empty, failed-empty, failed-partial, and deliberately stopped responses do not automatically reconnect or regenerate as if pending.

Private Markdown is rendered from history, with explicit running/stopped/failed labels. Editing or deleting an old `.md` sidecar has no authority. Root history corruption returns 503 rather than a salvaged prefix or an empty successful transcript.

Private session reads, by-origin reads, retry/stop, and reply streams retain owner/membership boundaries. Reply streams reject another vault member's private reply and recheck membership before emitting events, including after a stream has opened.

Public sharing uses a separate publication selection: only selected completed/stopped exchanges. Session bearer shares remain root-only, and reference annotations remain limited to their existing query/answer surface. Failed partials, inherited/raw model context, and generation internals are not added to public output. Promotion remains an explicit owner/editor command for completed/stopped nonempty answers, with the existing deterministic source/proposal identity and idempotent replay.

### What this reader is not yet

This is not the full `ConversationSnapshot` in the contract. In particular:

- There is no immutable interval capture with all history/app/access revisions and structural rechecks.
- Active progress still arrives through reply SSE. Private history responses do not yet contain the full same-attempt active overlay.
- Internal admitting/settling still appear as running in the compatibility reply snapshot; queued/generating/finalizing/readiness are not separately exposed.
- A missing/corrupt authorized child currently fails the read instead of retaining that child as a typed unavailable entry.
- Missing operations and DB/history inconsistencies still need the richer unavailable/readiness contract; current tests do not close all R gates.

The snapshot, publication compiler, and isolated PDF work remain separate. No new print flags or interactive-component PDF renderer are introduced.

## Tooling and verification

The verification seeder now creates synthetic native conversations through real admission and settlement, without invoking an LLM. Its provenance explicitly identifies synthetic fixture generation. Old schemas/projectors and the pre-native table/request shapes are detached under `scripts/lib/legacy-session-history.ts` for the existing historical migration/recovery tools. Those tools are not the missing legacy-to-native converter and must not run against live native histories.

Use the guarded disposable runner for database-backed suites:

```sh
pnpm test:history-settlement
pnpm test:history-settlement packages/server/test/query.integration.test.ts
pnpm test:history-settlement packages/server/test/reply-workflow-resume.integration.test.ts
pnpm test:history-settlement packages/server/test/read-endpoints.integration.test.ts \
  packages/server/test/write-endpoints.integration.test.ts \
  packages/server/test/shares.integration.test.ts
pnpm run typecheck
pnpm --filter web check
(cd web && pnpm exec vitest run src/lib/btw.test.ts src/lib/anchor-marks.test.ts)
```

The runner owns its container, database, volumes, and loopback port; overrides ambient database URLs; clears provider keys; and disables live smoke tests. Native API/process fixtures verify the explicit test URL and server-side database purpose marker before booting mutating services. Historical SQL tests use temporary old-format tables within the guarded database.

### Verified checkpoint

On 2026-10-11, the final server regressions passed in two independently owned disposable runs:

- **279 tests across 18 files**: history/storage, 51 admission cases, 40 settlement/restoration cases, private read/write/share regressions, six native process-restart cases, and historical migration/recovery fixtures.
- **44 query tests across one file**, with the live-provider smoke test skipped: model/tool loops, branch/context retention, stop/retry, frozen mode, finite reconciliation, ownership/revocation, failed-partial disclosure, and cost behavior.
- **27 browser-state/anchor tests across two files**.

That is **350 distinct passing tests across 21 files**, not one all-in-one run. Root typecheck, Svelte check, targeted formatting/lint, whitespace, and documentation checks accompany the checkpoint. Database migrations were applied only inside the disposable runs, which removed their containers, networks, and volumes.

The full query run took 465 seconds including provisioning and cleanup and continued to report roughly 15-second delays in query cases with `No healthy runners available` warnings. Their production significance and cause remain unverified; no production timeout was changed. Earlier failed fixture/typecheck attempts and the process-harness shutdown timeout are not counted as successful runs.

The six native process cases cover admission saved before DB confirmation with/without stop, provider death with/without stop, death during frozen-result publication, and publication failure after workflow completion followed by restart. They check native history and positive model/tool invocation ledgers. The process harness waits for workflow completion before graceful scope disposal; terminal DB state alone is not proof that workflow cleanup has completed.

These are controlled PostgreSQL/local-filesystem/process-crash and fake-provider/fake-R2 tests. They do not establish live provider/R2 behavior, universal power-loss guarantees, native data migration, or a safe production rollback after new-format writes.
