# Sessions, conversations, and vault content

> **Status:** exploratory proposal for future consideration. This is **not** an accepted architecture decision or implementation plan.

## Core clarification

The important distinction is not simply “completed sessions go in files, incomplete sessions go in DB.”

The better distinction is:

> **Active generation is operational state. Settled conversations are durable conversation history. Promoted conversations become vault corpus content.**

This keeps conversations durable and portable without automatically polluting the knowledge base.

## Three kinds of state

### 1. Vault corpus content

This is material Great Minds treats as source/knowledge:

```text
raw/**/*.md
wiki/**/*.md
archive/**/*.md
```

It participates in:

- compile;
- search;
- graph construction;
- citations;
- shared vault state;
- source lists and wiki lists.

Adding something here should be intentional.

### 2. Conversation history

This is user interaction history:

```text
.gm/sessions/<session_id>.jsonl
.gm/sessions/<session_id>.md
```

It includes:

- questions;
- answers;
- tool traces or selected source references;
- branches/BTWs;
- retries;
- stopped replies;
- failed outcomes and any committed partial answer;

It should be durable, readable, and exportable, but not automatically source evidence.

### 3. Active operation state

This is in-progress generation/workflow state:

```text
.gm/operations/replies/<reply_id>.json
```

and DB rows such as:

```text
replies
pipeline_runs
workflow journal state
```

It exists so the app can stream, resume, stop, or fail safely. It should not be treated as canonical vault content.

## Proposed file layout

```text
vault/
  raw/
    docs/
    sessions/                 # only promoted conversation-derived sources

  wiki/
  archive/
  config.yaml
  prompts/

  .gm/
    sessions/
      <session_id>.jsonl       # durable event log
      <session_id>.md          # derived readable transcript
    operations/
      replies/<reply_id>.json  # active checkpoint, removed or archived by policy
    compile/
      ...
```

The `.gm/` namespace is internal/product metadata, similar to `.git` but potentially exportable for advanced users.

## Where a non-completed session lives

A non-completed session can be file-backed, but not as vault corpus content.

Suggested split during active generation:

- `sessions` DB row: listing/origin/kind/current metadata.
- `replies` DB row: live status, partial answer snapshot, sources, cursor, stop flag.
- `.gm/sessions/<session_id>.jsonl`: durable session event log with meta and pending reply node.
- `.gm/operations/replies/<reply_id>.json`: active generation checkpoint/transcript/tool state.
- `.gm/sessions/<session_id>.md`: derived readable transcript, optionally updated only after settled turns.

This means the conversation is durable without making partial text a source document.

## Why terminal/settled state matters

During generation, the answer is unstable:

- tokens are partial;
- tool calls may be pending;
- sources may be provisional;
- fallback models may still change the answer;
- process crash after an external call may be ambiguous;
- user may stop the reply;
- the reply may fail.

A settled exchange is one with a terminal state:

- completed;
- stopped;
- failed;
- cancelled, if represented.

Terminal does not necessarily mean “successful.” It means no more automatic mutation is expected for that operation ID.

Only at settlement should the conversation history receive a final reply event that becomes durable conversation history.

## Why sessions should be distinct from `raw/` by default

If every chat were written to `raw/sessions/` automatically, then every exploratory conversation would become source material.

Problems:

- The agent may cite its own previous answer as evidence.
- Compile may synthesize questions and half-formed answers into wiki articles.
- Failed or stopped replies may pollute the corpus.
- Private exploratory thinking may become shared vault content.
- Search results become noisy.
- There is no clean accepted-knowledge boundary.

Therefore:

> **Chats are chats. Sources are sources. Users can promote a chat exchange into a source.**

## Promotion flow

When a user explicitly saves/promotes an exchange:

1. Read the settled session event from `.gm/sessions/<session_id>.jsonl`.
2. Build a source Markdown document with provenance frontmatter.
3. Write it under `raw/sessions/<exchange_id>-<source_id>.md`.
4. Commit/advance vault head.
5. Rebuild projections and enqueue/offer compile.

At that point the answer becomes part of the knowledge base.

## Possible session event model

The session JSONL can be append-only:

```jsonl
{"type":"meta","session_id":"...","query":"...","origin":null,"ts":"..."}
{"type":"reply","reply_id":"...","exchange_id":"...","status":"pending","question":"...","ts":"..."}
{"type":"reply","reply_id":"...","exchange_id":"...","status":"completed","question":"...","answer":"...","sources":[...],"messages":[...],"ts":"..."}
```

This was an initial sketch, not the target ordering rule. The [Stage 2A contract](./conversation-history-contract-and-migration.md#3-concrete-history-format) separates attempt acceptance from settlement: retain all attempts, select the latest accepted attempt per exchange, and settle by reply identity. A late settlement for an earlier attempt must not select it again merely because its event appears last.

## DB role for sessions

DB should support fast product behavior:

- list sessions;
- find sessions by origin;
- stream reply status;
- enforce user/vault access;
- hold live partial answer snapshots;
- hold active generation cursor and ambiguity markers;
- reconcile pending dispatch.

But the durable conversation transcript should be recoverable from files if sessions are considered portable user data. This is not a promise to recover every workspace choice or future execution policy from one transcript.

## Recovery scope and prompting

Recommend distinguishing content portability, compatible-app conversation reconstruction, full workspace restoration, and execution provenance/replay, as detailed in the [publication proposal](./session-publication-and-export-rewrite-proposal.md#recovery-contract--proposed-scope). Markdown should remain useful without Great Minds; structured history preserves recorded turns, outcomes, origins, and relationships. Current placement/defaults may be durable app state with their own backup/sync policy rather than content projections.

Historical reply policy is not the same fact as the conversation's current default. A thread can contain replies prepared in BTW mode followed by replies prepared in full-query mode. Changing the default must not reclassify the earlier attempts. Capture minimal per-attempt provenance where useful and known; retaining an exact prompt requires its text or an available immutable reference, not just a hash. Do not invent historical prompt/mode values during migration or infer them solely from current `kind`.

Current code keeps prepared mode, assembled system prompt, and prompt hash in operation state; session finalization copies only the turn messages after `turnStart`, not the leading system prompt. Prompt bodies also have a DB hash registry. These mechanisms are not yet a portable per-attempt prompt-history contract.

Coherence means explicit authority for each fact. DB-owned workspace choices are legitimate durable application data, not secretly disposable caches. A content-only import must identify which workspace settings are reset/defaulted; a fuller backup may include app state separately or as hidden metadata.

## Checkpoint lifecycle

Active reply checkpoints should have an explicit lifecycle:

```text
created/prepared
model/tool step claimed
external response checkpointed
terminal finalization committed
checkpoint deleted, compacted, or retained by explicit policy
```

The current docs say checkpoints are removed before terminal state; current code should be checked/fixed or docs should be updated. Future policy should be explicit:

- delete terminal checkpoints for privacy;
- compact them into `.gm/sessions` if needed;
- or retain them for debug/audit with clear retention controls.

## Sharing and privacy questions

Conversation history may be more private than vault corpus content. Future shared-vault policy should decide:

- Are sessions shared with vault collaborators by default?
- Are sessions user-private unless promoted?
- Are promoted exchanges visible as normal sources?
- Can a user share a single session outside the vault?
- Are hidden `.gm/sessions` encrypted with user-specific keys or vault keys?

A conservative model:

- conversation history is user-private by default;
- promoted sources are vault-shared;
- explicit session shares remain separate links/artifacts.

## Invariants to aim for

1. A pending reply never becomes source corpus content automatically.
2. A terminal exchange is durably represented in conversation history.
3. A promoted exchange is a new source document with provenance.
4. Content projections can be rebuilt from session history; active observations can be reconciled from operation state. Authoritative app/control state has a separate recovery policy.
5. Search/compile only include conversation content after explicit promotion.
6. Checkpoint retention is documented and enforced.

## Relationship to the session export/read-model proposal

With breaking API changes and verified data migration permitted, [Stage 2 of the publication/export proposal](./session-publication-and-export-rewrite-proposal.md#stage-2--canonical-conversation-history-read-model-and-migration) now recommends implementing terminal-history and content-metadata hardening together with the common conversation read model. Legacy DB-only failed outcomes and metadata would be migrated into versioned canonical history, not reconciled indefinitely in normal readers.

Its immutable `ConversationSnapshot` remains derived product data, not an additional canonical store or automatic source promotion. All terminal outcomes should use one idempotent history-before-publication settlement path. Authentication/access grants and active operation ledgers remain control state; file-recoverable settled content does not mean all DB rows or checkpoints are disposable.

Existing public-share disclosure and source-promotion eligibility must remain separate from the richer private read/export model. The [Stage 2A contract/migration draft](./conversation-history-contract-and-migration.md) and [test matrix](./conversation-history-acceptance-matrix.md) now specify the proposed next implementation, including app-owned placement/defaults and historical per-attempt provenance. They remain drafts, not implemented behavior; current physical session paths are retained for this cut rather than coupling it to `.gm/` relocation.

## Open questions

- Should `.gm/sessions/<id>.md` be regenerated after every terminal event or only on export/share?
- What failure diagnostics should history retain beyond the outcome, committed partial text, and selected source references?
- Should stopped replies with partial answers be promotable?
- Should session JSONL include full tool outputs or compact source references?
- In shared vaults, are conversations per-user private or vault-visible?
- Should session history sync between a user's devices even if not shared with collaborators?
