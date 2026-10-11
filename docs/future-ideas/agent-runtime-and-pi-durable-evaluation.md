# Agent runtime and `pi-durable` evaluation

> **Status:** exploratory proposal for future consideration. This is **not** an accepted architecture decision or implementation plan.

## Recommendation from discussion

Do **not** pivot wholesale from the current Effect-based Great Minds runtime to `pi` / `@earendil-works/pi-durable` right now.

Use `pi-durable` as a design reference. Consider a narrow spike only if it can preserve Great Minds' existing product semantics and delete meaningful complexity.

## Why not pivot wholesale now

### Great Minds already has product-specific semantics

The current reply pipeline is hand-rolled but encodes important behavior:

- browser-minted reply IDs;
- accepted `replies` row before dispatch;
- persisted full request;
- DB snapshot for SSE/read model;
- object checkpoint for generation state;
- session JSONL finalization;
- explicit no-automatic-retry policy for ambiguous external model/tool calls.

A generic durable agent runtime may not naturally encode all of those product decisions.

### Ambiguous external calls are a product policy, not just runtime mechanics

Great Minds currently tries not to spend again or repeat side effects merely because a process restarted after an external call.

Any replacement runtime must preserve this rule:

> If the system cannot know whether a model/tool call completed, do not automatically rerun it unless the operation is explicitly replay-safe or provider idempotency makes retry safe.

### `pi-durable` is experimental

The inspected package version `@earendil-works/pi-durable@1.1.0` identifies itself as experimental, with APIs subject to change.

That may be acceptable for an internal harness or spike. It is riskier as the core production runtime for billing-relevant model calls, conversation state, and future local-first sync.

### It would add another durability model

Great Minds already uses:

- Effect services/layers;
- Effect workflows;
- Postgres product tables;
- object-storage checkpoints;
- domain-specific session/reply/source models.

Adopting `pi-durable` could introduce a second conversation/task storage model and replay semantics, increasing cognitive load unless it replaces a large amount of current complexity cleanly.

### It does not solve the vault architecture

`pi-durable` would not solve:

- file-vs-DB source of truth;
- raw/wiki manifests;
- encrypted vault sharing;
- compile snapshot semantics;
- search/vector indexes;
- source deletion races;
- local-first sync;
- graph/query projections.

At most, it might help active reply/agent orchestration.

### Losing Effect consistency is not free

The repo is already Effect-shaped. Introducing a non-Effect runtime means either:

- wrapping it inside Effect, reducing the benefit; or
- letting one subsystem be stylistically different, increasing maintenance cost.

## What to steal from `pi-durable`

Even without adopting the package, Great Minds can use the ideas:

1. **Immutable entries**
   - Append-only event records for conversations/tasks.

2. **Commit before publish**
   - UI-visible state should be emitted only after durable state exists.

3. **External invocation records**
   - Record model/tool intent before execution and outcome after execution.

4. **Explicit replay policy**
   - Each tool/model step declares whether replay is safe, idempotent, unsafe, or ambiguous.

5. **Document/read-model split**
   - Canonical event log plus materialized read model.

6. **Atomic transition discipline**
   - Checkpoint and visible cursor/status should move together where possible.

7. **Crash recovery by inspecting committed state**
   - Restart should not depend on process memory.

## Great-Minds-native path

A likely better path is to keep Effect and refactor the current reply runtime into smaller domain modules.

Possible structure:

```text
reply-runtime/
  acceptance.ts
  checkpoints.ts
  state-machine.ts
  invocation-ledger.ts
  session-finalization.ts
  sse-read-model.ts
  reconciler.ts
```

The explicit state machine could be:

```text
accepted
prepared
model_invocation_claimed
model_response_checkpointed
tool_invocation_claimed
tool_result_checkpointed
settling
completed | failed | stopped
```

The goal is not to invent a generic agent runtime, but to make Great Minds' existing semantics obvious and testable.

## Possible invocation ledger

The current reply model uses active generation fields on `replies` plus checkpoint files. A future hardening step could add an invocation ledger:

```text
reply_invocations
  reply_id
  cursor
  kind                 # model | tool
  invocation_key
  request_hash
  provider/model/tool
  status               # claimed | completed | ambiguous | failed
  checkpoint_path
  created_at
  completed_at
```

Benefits:

- clearer ambiguity handling;
- auditability;
- easier crash tests;
- better provider cost tracing;
- easier replay/idempotency policy enforcement.

This captures much of the `pi-durable` lesson without adopting a moving runtime dependency.

## Narrow spike option

If the [conversation-history/API rewrite](./session-publication-and-export-rewrite-proposal.md) lands first, its verified contract and settlement semantics become the preservation baseline for any runtime spike. Do not retain legacy storage/API compatibility solely for a hypothetical runtime replacement, and do not add a second canonical conversation store.

A `pi-durable` spike could be useful if scoped narrowly:

> Can `pi-durable` replace only active reply-generation orchestration while preserving Great Minds' API, DB read model, session finalization, and no-ambiguous-auto-retry policy?

Out of scope for the spike:

- compile;
- source ingest;
- search;
- vault manifests;
- session file model;
- encrypted sync;
- schema-wide rewrite.

## Spike success criteria

Adopt only if all or most are true:

1. It removes substantial code or complexity from `replies.ts`/workflow glue.
2. It preserves current API behavior.
3. It writes the existing `replies` snapshots for SSE.
4. It finalizes into Great Minds session JSONL/markdown.
5. It preserves no-ambiguous-auto-retry semantics.
6. It supports explicit replay-safe vs replay-unsafe tools.
7. It survives fault-injection restart tests.
8. It does not introduce a second canonical conversation store.
9. It can be cleanly wrapped in Effect or replaces enough Effect workflow usage to justify the mismatch.
10. It has acceptable dependency/API stability for production.

## Decision matrix

| Option | Recommendation | Notes |
| --- | --- | --- |
| Wholesale pivot to `pi-durable` | No for now | Too much migration risk; does not solve vault source-of-truth. |
| Use `pi-durable` only for replies | Maybe after spike | Only if semantics are preserved and code shrinks. |
| Keep Effect and steal patterns | Yes | Best default. |
| Build Great-Minds-native durable reply journal | Probably best near-term | Preserves domain semantics and avoids moving dependency. |

## When to reconsider

Reconsider broader adoption if:

- `pi-durable` stabilizes APIs;
- it becomes already integrated with Effect or simple to wrap;
- the current reply runtime becomes a major source of bugs;
- a spike proves major simplification;
- future agent features require generic durable multi-agent/thread/document primitives beyond current Great Minds needs.

## Open questions

- Should compile LLM calls get the same invocation ledger pattern as replies?
- Should model/tool invocation records be product tables or hidden operation files?
- Can a Great-Minds-native reply state machine be made small enough that an external runtime is unnecessary?
- What durability tests must pass before changing reply runtime internals?
