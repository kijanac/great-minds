# DB/files roles for an Obsidian-like vault

> **Status:** exploratory proposal for future consideration. This is **not** an accepted architecture decision or implementation plan.

## Thesis

Great Minds should move toward this mental model:

> **A vault is a durable folder/repo of Markdown plus hidden manifests. The database is the fast index, projection layer, and durable operation ledger for that repo.**

Or shorter:

> **Files own vault content. The DB owns control state and projections.**

This aims to improve durability, race-freeness, clarity, simplicity, and Obsidian-likeness.

## What files should own

Files should own anything a user would reasonably think of as “my knowledge base” or “my portable vault.”

Canonical vault files could include:

```text
config.yaml
prompts/*.md
raw/**/*.md
wiki/**/*.md
archive/**/*.md
.gm/compile/<compile_id>/manifest.json
.gm/compile/<compile_id>/source-cards.jsonl
.gm/compile/<compile_id>/topics.json
.gm/compile/<compile_id>/topic-membership.jsonl
.gm/sessions/<session_id>.jsonl        # if sessions are file-backed history
.gm/sessions/<session_id>.md           # derived readable transcript
```

A useful content-recovery test:

> If Postgres disappeared, could a compatible Great Minds app point at the vault files and rebuild content registries, graph/search projections, recorded content metadata, and content views?

For committed vault content, the desired answer is yes. This is not a promise to restore every workspace choice, future model policy, permission, or active operation from Markdown. Content should remain meaningful in Obsidian without that app state. Full workspace restoration needs a separate app-state backup, which may also be packaged as hidden metadata without compromising Markdown portability.

## What DB should own

The DB should be authoritative for state that is not vault content:

- durable workspace/presentation choices and future response defaults, where intentionally app-owned;
- users/auth/passkeys;
- hosted-mode memberships/roles/invites/shares;
- durable operation records;
- idempotency keys;
- job queues/intents;
- locks/leases;
- active generation/compile state;
- outboxes;
- billing/cost/audit events;
- projection watermarks;
- current read models for fast UI.

Examples:

```text
users
vaults
vault_memberships
shares
pipeline_runs
compile_intents
file_ingest_batches
file_ingest_files
url_ingest_requests
replies for active/live generation state
source_deletion_outbox
llm_cost_events
```

The DB can also hold rebuildable projections:

```text
source_documents
wiki_articles
search_index
ideas
anchors
topics
topic_membership
topic_links
topic_related
backlinks
```

But those should be understood as projections of committed vault content, not independent truth.

## Avoid “whatever files happen to exist” as truth

For race-freeness, the live vault should not be defined by scanning an object-store prefix.

Instead:

> **The live vault is the latest committed manifest/head.**

Files in storage can exist in several states:

- staged;
- proposed;
- current;
- archived;
- pending deletion;
- cached;
- orphaned;
- garbage-collectable.

Only files referenced by the current committed vault head/manifest are live content.

This avoids a class of bugs where an R2 object left behind by a failed delete or failed archive is rediscovered and treated as current content.

## Proposed head/manifest model

A hosted Postgres v1 could keep the current vault head in a DB row while storing content in files/objects.

A local-first/encrypted future could store heads as signed objects.

Conceptually:

```text
vault_head
  vault_id
  head_id
  parent_head_id
  manifest_hash
  created_at
  author_user_id
  author_device_id?
```

The manifest describes which objects are current:

```json
{
  "vault_id": "...",
  "head_id": "...",
  "parents": ["..."],
  "config": "config.yaml#sha256:...",
  "raw": [
    {"path": "raw/docs/a.md", "hash": "...", "source_id": "..."}
  ],
  "wiki": [
    {"path": "wiki/topic.md", "hash": "...", "topic_id": "..."}
  ],
  "archive": [
    {"path": "archive/...", "hash": "..."}
  ],
  "compile": {
    "current_snapshot": ".gm/compile/.../manifest.json#sha256:..."
  }
}
```

The exact representation can evolve; the key idea is that a committed manifest defines live content.

## Publish boundary

Every content mutation should have one clear publish point.

Desired flow:

1. Write/stage new files or immutable objects.
2. Verify hashes.
3. Create a manifest/commit that references those objects.
4. Atomically advance `vault_head` from old head to new head.
5. Rebuild or update DB projections for that head.

If step 4 does not happen, staged files are not live. If projection rebuild fails after step 4, content is still durable and projections can be retried.

## Suggested rules

### Rule 1: User-visible vault content must be file-backed

If users would expect to export it, sync it, or see it in an Obsidian-like folder, it should not live only in Postgres.

### Rule 2: DB state is either control-plane truth or projection

Every DB table should be classified as one of:

- application/control-plane authoritative;
- projection/read model;
- cache;
- temporary/staging;
- audit/billing.

Avoid ambiguous tables that are half-canonical content and half-cache.

### Rule 3: Storage scans are repair/import, not normal authority

The app may scan object storage to rebuild indexes or detect corruption, but normal “what is live?” should come from the committed manifest/head.

### Rule 4: Projections carry a watermark

Projection tables should record which vault head/content hash they reflect.

Examples:

```text
source_documents.projected_from_head
wiki_articles.projected_from_head
search_index.projected_from_head
topics.projected_from_head
```

This lets the UI show “indexing” or “stale” rather than silently serving old projections.

### Rule 5: Config changes are content changes

Changing `config.yaml` should advance the vault head and mark compile projections stale or enqueue/offer a compile.

### Rule 6: Deletion is a content commit, not merely DB row removal

Deleting a source should commit a manifest/tombstone that removes it from live content. Physical object cleanup can happen later.

### Rule 7: Caches are deletable without losing accepted content

If deleting a “cache” changes accepted content, call it behavior-shaping or snapshot state instead.

### Rule 8: Accepted LLM output should be file-backed

If compile output is user-visible and expensive/stochastic, accepted outputs should be stored as snapshot files/manifests, not only as DB graph rows.

## How this maps to current Great Minds concepts

### Raw sources

Canonical:

```text
raw/**/*.md
```

Projection:

```text
source_documents
search_index where path like raw/%
ideas
anchors
```

### Wiki articles

Canonical:

```text
wiki/**/*.md
archive/**/*.md
.gm/compile/<compile_id>/...
```

Projection:

```text
topics
wiki_articles
topic_membership
topic_links
topic_related
backlinks
search_index where path like wiki/%
```

### Vault config and prompts

Canonical:

```text
config.yaml
prompts/*.md
```

Projection/audit:

```text
prompts hash table
compile snapshot metadata
```

### Sessions/conversations

Canonical conversation history could be file-backed under hidden `.gm/sessions`, but should not automatically enter the raw corpus.

Promoted answers/sessions become canonical source docs under `raw/sessions/...`.

With breaking contracts and data migration permitted, the proposed [session publication rewrite](./session-publication-and-export-rewrite-proposal.md) now recommends implementing this authority boundary for conversations: migrate DB-only terminal outcomes and selected content/provenance facts into versioned history, then project an immutable `ConversationSnapshot` for consumers. That snapshot is not another authoritative store or vault commit. Recovery tests should cover settled conversation content and recorded provenance, not assume every listing/placement/default field is content. They do not imply recovering authentication, active operations, or share grants from untrusted transcript files, or completing the source/wiki manifest migration.

### Jobs and active operations

Canonical control state:

```text
pipeline_runs
compile_intents
replies
file/url ingest operation tables
outboxes
```

Active checkpoints can live under `.gm/operations/...` or object storage, but they are operational state, not vault corpus content.

## Compile snapshots as files

Accepted compile output should probably have a snapshot manifest.

Possible layout:

```text
.gm/compile/<compile_id>/manifest.json
.gm/compile/<compile_id>/source-cards.jsonl
.gm/compile/<compile_id>/topics.json
.gm/compile/<compile_id>/topic-membership.jsonl
.gm/compile/<compile_id>/rendered-articles.jsonl
```

The manifest should record:

- base vault head;
- config hash;
- source manifest hash;
- prompt/model versions;
- output object hashes;
- compile run ID;
- author/device in local-first future;
- signature in shared encrypted future.

Then DB compile tables become projections/materializations of accepted snapshots.

## Deletion and tombstones

A clean deletion flow:

1. User requests delete.
2. Commit new vault head omitting the source and recording a tombstone.
3. Projection worker removes source row/search rows/idea rows/topic memberships that are no longer valid.
4. Physical storage cleanup runs later and can be retried.

This avoids “DB says deleted, object still exists and gets rediscovered.”

## Suggested migration path

1. Document current table/file authority classes.
2. Add integrity checks for obvious DB/file drift.
3. Add projection watermarks/head hashes without changing product behavior.
4. Stop treating object-store scans as normal liveness authority; use manifest/head where possible.
5. Introduce manifest commits for source add/delete/config changes.
6. Make compile outputs snapshot-backed.
7. Rebuild DB projections from committed vault head.
8. Later adapt the manifest/object model to encrypted sync.

## Open questions

- Should the initial `vault_head` live in Postgres only, or also as an object file?
- How much of `.gm/` should be user-visible/exported?
- Should sessions be part of the vault repo, user-private state, or optional export?
- How should manual file edits/imports be detected and committed?
- What is the UX for projection stale states?
- Which existing DB tables can be rebuilt exactly from files, and which need additional snapshot files?
