# Local-first runtime and storage substrates

> **Status:** exploratory proposal, not a verified decision. This note records future implementation options and tradeoffs.

## Goal

Move plaintext vault content and derived semantic indexes out of central infrastructure while preserving Great Minds' current UX: vault library, reading room, graph/wiki articles, search, research sessions, compiles, and citations.

The proposed direction is staged:

1. Run the existing API locally behind the same `/v1` contract.
2. Keep plaintext authoritative state local.
3. Treat remote infrastructure as encrypted sync/backup/coordination.
4. Later choose whether to remain Postgres-compatible or migrate to a more embedded substrate.

## Why local runtime first

Trying to design encrypted multi-device sharing, conflict resolution, and key rotation before proving the local runtime creates too many moving parts. A safer sequence:

1. Existing web UI talks to local API.
2. Local API uses local DB and local object store.
3. Existing queries/compiles/sessions work with minimal semantic change.
4. Then define encrypted sync below the product state.

This preserves product behavior while moving the main trust boundary.

## Candidate storage substrates

### Native local Postgres + pgvector

Best first step if preserving behavior matters most.

Pros:

- Current schema already uses Postgres constructs.
- Current migrations and Drizzle `pg-core` schema mostly carry over.
- Supports `jsonb`, `tsvector`, `pgvector`, HNSW, UUIDs, transactional behavior.
- Current Docker already uses `pgvector/pgvector:pg18`.
- Lowest implementation risk for Phase 1.

Cons:

- Harder local packaging.
- Requires managing a Postgres process/data directory.
- Not browser-native.
- Plaintext remains in local Postgres unless protected by OS/app encryption.
- Not an encrypted sync format by itself.

Use when:

- The priority is to remove central plaintext exposure quickly without rewriting graph/search/compile semantics.

### PGlite

PGlite is a WASM Postgres packaged for browser, Node, and Bun. Latest researched version was `@electric-sql/pglite@0.5.8`, with Postgres 18.3 since PGlite `0.5.0`.

Pros:

- Much better Postgres compatibility than SQLite.
- Runs in browser/Node/Bun without installing Postgres.
- Supports extensions including `pgvector` via `@electric-sql/pglite-pgvector`.
- Supports IndexedDB persistence and OPFS AHP in workers.
- `pglite-socket` can expose a local Postgres-compatible socket for development/prototyping.

Cons and caveats:

- PGlite starts Postgres single-user with fsync disabled (`-F`) and relies on VFS `syncToFs`; do not treat durability as equivalent to native Postgres.
- IndexedDB FS loads DB files into memory and flushes changed whole files after queries.
- `relaxedDurability` can return before flush; avoid for canonical user data.
- OPFS AHP is not supported by Safari due to sync access handle limits.
- PGlite is single-connection; multi-tab worker or socket multiplexing is a proxy, not normal Postgres concurrency.
- Browser storage can be evicted and is not encrypted by default.

Use when:

- You want a Postgres-compatible embedded prototype.
- You want browser/offline experiments.
- You accept additional crash/quota testing before treating it as canonical storage.

### SQLite

Best long-term embedded durability substrate if the product can afford a portability layer.

Pros:

- Excellent embedded/local packaging.
- Mature crash recovery.
- WAL mode gives good local concurrency for one writer/many readers.
- Strong fit for desktop/mobile local-first.
- Single-file mental model plus WAL sidecars.

Cons:

- Requires real schema/query port from Postgres.
- Need substitutes for `pgvector`, HNSW, `tsvector`, `jsonb` operators, enum/default/timestamp behavior.
- Search and vector semantics likely change unless isolated behind interfaces.
- One writer at a time.
- Not encrypted unless using SQLCipher, OS encryption, or separate app-layer encryption.

Conservative local settings to evaluate:

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA wal_autocheckpoint = 1000;
PRAGMA trusted_schema = OFF;
```

Performance-oriented local apps often use `WAL + synchronous=NORMAL`, but then a newly acknowledged commit can disappear after power/OS failure. That may be acceptable for rebuildable projections, not for canonical user edits unless UX and backup/sync semantics account for it.

## Recommended staging path

### Phase 1 — local API with native Postgres

- Run the current server locally.
- Keep the existing `/v1` API contract.
- Use local Postgres/pgvector.
- Use local filesystem object store.
- Route model calls from local runtime.
- Provide local bootstrap auth.

Expected benefit: central infrastructure no longer sees plaintext vault content or prompts for local-mode users.

### Phase 2 — define state boundaries

Classify every table/file as one of:

- canonical/syncable
- local projection/rebuildable
- ephemeral workflow state
- audit/billing
- identity/access metadata

Candidate canonical state:

- raw source documents and metadata
- source identities/content hashes
- vault configuration
- user-visible session events and settled replies
- accepted wiki/article snapshots, if they are treated as product state
- membership/key events in shared vaults
- signed commit metadata

Candidate derived/rebuildable state:

- `search_index`
- vector indexes
- compile caches
- rendered pipeline progress snapshots
- temporary model transcripts/tool outputs
- active worker scheduler state

### Phase 3 — encrypted sync beneath canonical state

- Package canonical state into encrypted content-addressed objects/packs.
- Upload objects before signed commits.
- Advance encrypted/signed heads after objects exist.
- Rebuild local projections after pull.

### Phase 4 — evaluate embedded substrate

Only after the state boundary is clean:

- Try PGlite if Postgres compatibility still dominates.
- Try SQLite if packaging/local-first distribution dominates.
- Keep canonical sync format independent of any one local DB engine.

## Preserving graph, compile, and query UX

A local-first move should not force a worse UX. The main trick is to separate the canonical graph from local projections.

### Sources and ideas

Canonical:

- raw source object
- source metadata
- extracted idea records if accepted as part of published compile snapshot
- anchors and provenance if user-visible

Derived:

- search chunks
- embeddings
- vector index layout

### Topics and wiki articles

Two possible models:

1. **Compile output as canonical snapshot**
   - Accepted topic/article graph is synced.
   - Other devices can render immediately.
   - Later compiles produce new signed snapshots.

2. **Compile output as local projection**
   - Sync only sources/config.
   - Every device compiles locally.
   - Harder to preserve shared UX and deterministic graph identity.

For collaborative vaults, the first model is probably better: accepted compile outputs become canonical vault commits, while search/vector indexes remain local projections.

### Query semantics

A local query should use:

- local source bodies
- local search/vector index
- local or direct provider model call
- local reply/session state

If remote sync is behind, query UX should clearly indicate it is answering from the local vault state at a specific head.

## Storage testing requirements

Before making a local substrate canonical, test:

- process kill during write
- OS crash/power-loss simulation where possible
- interrupted object writes
- interrupted sync head update
- corrupted/torn local files
- quota exhaustion
- disk full
- browser storage eviction for web modes
- concurrent tabs/processes
- migration interruption and retry
- export/import recovery

## Open questions

- Is native Postgres acceptable for the first local product release?
- Is browser-first offline important enough to accept PGlite constraints?
- Will mobile/desktop packaging require SQLite eventually?
- Should compile outputs be canonical synced artifacts or local-only derived state?
- Which local data should be encrypted above OS disk encryption?
- How will users back up a local vault before encrypted sync exists?
