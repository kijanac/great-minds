# Future ideas: privacy, local-first, durable sync

> **Status:** exploratory notes and proposals for future consideration. These are **not** accepted architecture decisions, not implementation commitments, and not verified product behavior. They preserve the design space we explored so the ideas can be revisited deliberately.

These notes collect a thread of design work around reducing Great Minds' exposure to infrastructure providers, moving toward a local-first vault runtime, encrypted sync/sharing, stronger durability semantics for long-running work, and trustworthy publication/export of research sessions.

## Documents

- [Privacy posture and provider options](./privacy-posture-and-provider-options.md)
  - Current plaintext exposure surfaces.
  - Swiss/private infrastructure options.
  - Model routing modes: local-only, direct BYOK/ZDR, brokered convenience.
  - Practical privacy ladder.

- [Local-first runtime and storage substrates](./local-first-runtime-and-storage.md)
  - How to stage a local runtime without rewriting the product at once.
  - Native Postgres vs PGlite vs SQLite tradeoffs.
  - What state should be canonical vs derived/rebuildable.
  - Preserving graph/search/query UX.

- [Encrypted vault sync and sharing](./encrypted-vault-sync-and-sharing.md)
  - Encrypted object/commit/head model.
  - Per-device keys, vault epochs, grants, signatures.
  - Revocation limits and possible server/client two-part keys.
  - Sync protocol sketch.

- [Durability lessons for restart and sync safety](./durability-restart-sync-lessons.md)
  - Lessons inspired by durable-agent runtimes without assuming Great Minds should adopt one directly.
  - Commit-before-publish, external invocation records, ambiguity handling.
  - Local durability vs sync durability.

- [Compile ownership and local-first compile semantics](./compile-ownership-and-local-first-semantics.md)
  - Current relationship between vault ownership and compiles.
  - Proposed snapshot-based compile model.
  - How compile artifacts might be signed and accepted in shared encrypted vaults.

- [Model and provider routing ideas](./model-and-provider-routing.md)
  - Privacy-mode routing for local-only, BYOK, ZDR/no-training, private endpoint, and brokered model calls.
  - Workload-specific considerations for embeddings, query/reply, compile, and web search.

- [Current production source-of-truth audit](./prod-source-of-truth-audit.md)
  - Code-level audit of where prod appears to treat files, DB rows, workflow state, and indexes as truth.
  - Potential incoherences such as object/DB split-brain, stale projections, config/output drift, and checkpoint retention.

- [DB/files roles for an Obsidian-like vault](./db-files-obsidian-vault-proposal.md)
  - Proposal that files own vault content while DB owns control state and projections.
  - Manifest/head model for race-free live content and rebuildable projections.

- [Sessions, conversations, and vault content](./sessions-conversations-vault-content-proposal.md)
  - Proposal distinguishing active generation, durable conversation history, and promoted source corpus content.
  - Suggested `.gm/sessions`, `.gm/operations`, and `raw/sessions` roles.

- [Agent runtime and pi-durable evaluation](./agent-runtime-and-pi-durable-evaluation.md)
  - Recommendation not to pivot wholesale to `pi-durable` now.
  - Ideas to steal, possible narrow spike, and Great-Minds-native reply runtime path.

- [File-backed vault migration sketch](./file-backed-vault-migration-sketch.md)
  - Staged path from current mixed DB/R2 authority to a manifest-backed file vault model.
  - Integrity checks, projection watermarks, manifest commits, compile snapshots, sessions, and encrypted sync preparation.

- [Session publication and export rewrite](./session-publication-and-export-rewrite-proposal.md)
  - Proposed replacement of live-app printing with an immutable conversation snapshot, shared publication compiler, and isolated document view.
  - Revised Stage 2 includes canonical terminal history, content metadata, unified settlement, and verified data/API migration; breaking changes are permitted where they simplify the result.
  - Staged citation, typesetting, PDF-generation, testing, and deletion work, with explicit disclosure policy for Markdown/public-share consumers.

- [Conversation history: Stage 2A contract and migration](./conversation-history-contract-and-migration.md)
  - Concrete implementation draft against `main` at `fe332ba`: versioned JSONL records, app-state separation, per-attempt provenance, admission/settlement protocol, and shared reads.
  - Field-level migration rules, conditional-write requirements, maintenance cutover/rollback boundaries, and code ownership.
  - Preserves current BTW/standalone UX without promising full workspace recovery from one transcript. [Native workflow integration](../conversation-workflow-integration.md) is implemented and tested separately; no production migration has been executed.

- [Conversation history: acceptance-test matrix](./conversation-history-acceptance-matrix.md)
  - Format, prompting, crash/reconciliation, hydration, disclosure, migration, and later publication gates mapped to existing or proposed tests.
  - Existing baseline and implemented evidence are separated from original targets. The bounded read pass explicitly defers comprehensive capture envelopes and other unnecessary surfaces; offline conversion and restore/cutover rehearsal remain required.

## Common framing

The strongest privacy direction is **local-first**:

1. Plaintext vault content, indexes, sessions, reply state, and compile orchestration live on the user's device.
2. Remote infrastructure stores encrypted blobs, encrypted/signed heads, and minimal coordination metadata.
3. Model calls originate from the local runtime, either to local models, direct user-controlled providers, zero-data-retention providers, private endpoints, or explicitly opted-in brokered convenience providers.

The least risky implementation path is probably staged:

1. Make the existing backend run locally behind the same `/v1` API contract.
2. Keep native Postgres/pgvector first if preserving current semantics is the priority.
3. Move object storage to a local filesystem store.
4. Then introduce encrypted remote sync/sharing below the product model.
5. Later evaluate PGlite/SQLite if packaging, mobile/browser support, or fully embedded distribution matters more than Postgres compatibility.

## Non-goals of these notes

- They do not replace `docs/durable-operations.md`, which documents current durable behavior.
- They do not certify any provider, jurisdiction, or encryption design as sufficient.
- They do not decide a storage substrate.
- The Stage 2A conversation draft includes a migration specification and test gates, but is not an estimated or production-approved cutover plan; the wider proposals remain exploratory.
- They do not claim revocation can erase content a collaborator already decrypted.

## Questions to answer before implementation

1. Is Phase 1 local runtime allowed to require local Postgres, or must it be single-binary/embedded?
2. Which data is authoritative and syncable vs derived and local-only?
3. Are compiles user-triggered only, automatic after edits, or both?
4. Which roles can publish canonical shared vault commits and compile artifacts?
5. Does v1 encrypted sharing require server-assisted two-part keys, or is client-held epoch keying enough?
6. What is the acceptable UX for stale local compiles, unsynced local saves, and revoked remote access?
7. Which provider privacy modes are product-supported vs advanced settings?
