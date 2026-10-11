# Current production source-of-truth audit

> **Status:** exploratory audit notes for future consideration. These are **not** accepted architecture decisions, not implementation commitments, and not verified against the live production database. They summarize what the code appears to do and where the product model may become incoherent.

## Scope

This note records the current code-level picture of where Great Minds stores content and state in production, and where file/object state and database state can diverge.

Production configuration currently uses:

- Render-hosted API and Postgres.
- Cloudflare R2 object storage via `STORAGE_BACKEND=r2`.
- R2 bucket `gm-prod-shared`.
- Render disk `/data`, mainly for local diagnostic compile logs such as `.compile/<vault>/log.md`.
- OpenRouter/model providers for LLM and embeddings.

This audit is about authority boundaries, not provider privacy.

## High-level current model

The current app uses a composite source of truth:

- **Object storage / files** hold large Markdown bodies and checkpoints.
- **Postgres** holds identity, registry rows, metadata, permissions, job state, graph state, reply/session read models, search index, and compile cache.
- **Effect workflow journal tables** are intended execution machinery, not product truth.

That split is not inherently wrong. The issue is that some subsystems treat object files as authoritative while others treat DB rows as authoritative, and updates across R2/Postgres are not atomic.

## Current storage map

| Area | Object/file state | DB state | Current practical authority |
| --- | --- | --- | --- |
| Vault identity and membership | none | `vaults`, `vault_memberships`, `users` | DB |
| Vault config | `vaults/<id>/config.yaml`, default fallback | no dedicated config row | File, but DB/projected outputs may lag |
| Custom prompts | `vaults/<id>/prompts/*.md`, bundled fallback | `prompts` table records seen prompt hashes/content | File/fallback for active prompt; DB for prompt audit/history |
| Raw sources | `vaults/<id>/raw/**/*.md` | `source_documents` registry/metadata | Mixed: file body + DB registry |
| User references | `users/<id>/refs/**/*.md` | `user_documents` registry/metadata | Mixed: file body + DB registry |
| Proposals | `proposals/<proposal_id>.md` | `source_proposals` status/dest/source metadata | Mixed: DB status + file body |
| Wiki articles | `vaults/<id>/wiki/*.md`, `archive/...` | `topics`, `wiki_articles` | Mixed: file body + DB registry/status |
| Topic graph | none directly | `topics`, `topic_membership`, `topic_links` | DB currently |
| Search/query retrieval | copied chunk bodies in `search_index` | `search_index` with tsv/vector/body | DB projection, but served as search truth |
| Sessions | `vaults/<id>/sessions/<id>.jsonl` and `.md` | `sessions` registry/listing/origin/kind | Mixed: JSONL is transcript/event log; DB is listing/read model |
| Replies | `operations/replies/<reply_id>.json` checkpoints | `replies` status/answer/sources/request/cursor | Mixed: DB is visible state; checkpoint resumes active generation |
| Jobs/workflows | no canonical files | `pipeline_runs`, `compile_intents`, ingest request tables | DB product/control state |
| Compile cache | none | `compile_cache_entries` | DB behavior-shaping cache |
| Generated indexes | `wiki/_index.md`, `raw/_index.md` | source/wiki list tables | Files are generated artifacts, not list authority |

## Current coherences that seem intentional

### Product tables vs workflow journal

The code and `docs/durable-operations.md` intentionally keep product state in product tables and use Effect workflow journal state as execution machinery.

This is good and should be preserved.

### Topic intent vs rendered article reality

`topic_links` and `backlinks` are not redundant in concept:

- `topic_links` represent intended topic links from reduce/derive.
- `backlinks` represent actual links found in rendered Markdown.

That split is coherent if documented as intent vs rendered reality.

### Large bodies outside workflow payloads

Keeping raw source bodies, provider transcripts, checkpoints, and large session files out of workflow payloads is directionally sound.

## Potential incoherences and race windows

### 1. Raw source file vs `source_documents` row

Raw source ingest usually writes an R2 file, then indexes/upserts `source_documents`.

Compile ingest scans `raw/` files and can refresh missing/stale rows from storage. This gives partial self-healing when an object exists and the row is missing.

But the reverse is weaker:

- A `source_documents` row can exist while the R2 file is missing.
- Source listing and metadata can still show the DB row.
- `readSource` fails because content is missing.
- Search rows may be cleaned up if the file no longer appears during raw rebuild.
- The source registry row itself is not necessarily deleted.

### 2. Source deletion can race with storage reconciliation

Current deletion deletes DB graph/search/registry state and records `source_deletion_outbox`, then best-effort deletes the R2 object.

If R2 deletion fails and a compile scans `raw/` before the outbox succeeds, the leftover file can be re-indexed into `source_documents`. Later the outbox can delete the file, leaving a DB row pointing to missing content again.

Deletion also deliberately creates no compile intent, so wiki/topic outputs can keep reflecting deleted sources until a later compile.

### 3. Wiki article files and wiki/article DB rows can diverge

Rendering writes `wiki/<slug>.md`, upserts `wiki_articles`, updates `topics`, and may delete an old path. Archive transitions update topic status, copy file to `archive/...`, delete old file, and update `wiki_articles`.

These are not atomic across R2/Postgres.

Possible drift:

- Wiki file exists without `wiki_articles` row.
- `wiki_articles` row points at a missing file.
- `topics.articleStatus` and `wiki_articles.archived` disagree.
- Old slug files remain after a rename/archive failure.
- Wiki search rebuild can scan orphan `wiki/` files directly from R2 and make them searchable even if not in `wiki_articles`.

### 4. Search is derived but served as truth

`search_index` is derived from raw/wiki Markdown, but query tools serve snippets and chunk expansion from `search_index.body`.

If stale, search may return passages that no longer match document reads. This can cause answers to cite stale snippets.

There does not appear to be a universal invariant that a served search row must match current committed document content.

### 5. Config changes do not obviously invalidate compiles

`updateVaultConfig` writes `config.yaml` but does not appear to:

- enqueue a compile intent;
- mark topics/articles dirty;
- attach config hash to compile output;
- prevent old wiki outputs from being treated as current.

So users can see updated config while ideas/topics/articles still reflect an older config.

### 6. Source metadata is duplicated in frontmatter and DB

Extract writes enriched metadata into both Markdown frontmatter and `source_documents` columns/`derived_extras`.

Most listing/filter/query-document paths use DB metadata. `refreshFromStorage` does not appear to fully rehydrate all enriched metadata from frontmatter.

Therefore file frontmatter is not a complete authoritative backup for the DB row.

### 7. Sessions and replies have overlapping truth surfaces

Current session/reply state spans:

- `replies` row: live status/SSE snapshot/request/cursor/sources/answer.
- `operations/replies/<reply_id>.json`: active generation checkpoint.
- `sessions/<session_id>.jsonl`: conversation event log.
- `sessions/<session_id>.md`: readable derived transcript.
- `sessions` row: listing/origin/query/kind metadata.

The split is understandable but has crash windows. For example finalization can append session JSONL and rebuild markdown, then update `replies`; failure midway can leave JSONL and reply row disagreeing.

A specific documentation/code mismatch observed: `docs/durable-operations.md` says reply checkpoint files are removed before terminal state, but current code appears to write/read checkpoints without deleting `operations/replies/<reply_id>.json` after terminal finalization.

### 8. Proposal body and proposal row can diverge

Proposal creation inserts `source_proposals`, then writes the proposal body file. If the write fails after DB insert, a proposal row can lack a body.

Review operations can also delete or move proposal content before status update. The operations are mostly retry-tolerant but not one atomic commit.

### 9. User references lack a robust reconciler

User references use R2 files plus `user_documents` rows. There is no obvious equivalent to source-file reconciliation.

Potential drift:

- orphan `refs/` file with no DB row;
- DB row pointing to missing file;
- share resolution failing for a previously shared reference.

Some reference metadata is intentionally DB-only, such as title edits.

### 10. Compile cache is behavior-shaping, not a harmless cache

`compile_cache_entries` is called a cache, but it can affect:

- extract reuse;
- idea ID stability;
- render reuse;
- compile reproducibility.

Deleting it should not lose user-authored content, but it can change future generated outputs. It should be named and treated as rebuildable-but-behavior-shaping state.

### 11. Generated index files are derived artifacts

`wiki/_index.md` and `raw/_index.md` are generated during publish. Lists are served from DB tables, and search indexing skips underscore files.

These files should not be treated as authoritative content lists.

### 12. Deployment comment drift

`render.yaml` comments mention proposal bodies under `DATA_DIR`, but with `STORAGE_BACKEND=r2`, proposal bodies use R2. Compile logs still use `/data`.

## Suggested verification checks for later

These are not implementation instructions, just possible audit queries/checks:

- DB sources whose file is missing in storage.
- Storage raw files without `source_documents` rows.
- `wiki_articles` rows whose file is missing.
- `wiki/` files not referenced by live `wiki_articles` rows.
- `topics.article_status` disagreement with `wiki_articles.archived`.
- Reply checkpoints for terminal replies.
- `sessions` rows missing JSONL files.
- Proposal rows missing proposal bodies.
- User document rows missing reference files.
- Search rows whose `content_hash` no longer matches current chunk content.

## Directional conclusion

The current architecture would be easier to reason about if it made one explicit distinction everywhere:

> Files/commits contain vault content. DB rows are either control-plane truth or projections of a committed vault head.

Today, that line exists in places but is not universal.
