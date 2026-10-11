# File-backed vault migration sketch

> **Status:** exploratory proposal for future consideration. This is **not** an accepted migration plan, not estimated, and not verified.

## Purpose

This note sketches how Great Minds might move from the current mixed DB/R2 authority model toward a clearer Obsidian-like file-backed vault model without a disruptive rewrite.

## Desired end state

- Canonical vault content is represented by files plus a committed manifest/head.
- DB product/control tables coordinate operations and access.
- DB projection tables can be rebuilt from the committed vault head.
- Search/query/compile serve projections with explicit freshness watermarks.
- Object-store scans repair/import state but do not define live content by themselves.

## Phase 0: document current authority

Classify each table and storage prefix:

- canonical control-plane state;
- canonical vault content;
- projection;
- cache;
- temporary/staging;
- audit/billing.

This should produce an authority matrix maintained alongside schema migrations.

## Phase 1: add integrity checks

Add read-only checks before changing behavior:

- source rows with missing files;
- raw files without source rows;
- wiki article rows with missing files;
- wiki files not referenced by live article rows;
- terminal replies with retained checkpoints;
- sessions rows missing JSONL files;
- search rows whose chunk hashes no longer match current content;
- config hash not matching latest compile snapshot.

Initially these can be admin scripts or scheduled diagnostics.

## Phase 2: add projection watermarks

Add fields or sidecar tables that say which content state projections reflect.

Example:

```text
projection_state
  vault_id
  projection_name      # source_registry, raw_search, wiki_search, topic_graph, backlinks
  projected_head
  projected_at
  status              # current | stale | rebuilding | failed
  error
```

This avoids silently serving stale indexes as if they are current.

## Phase 3: introduce a manifest without changing UX

Start writing a vault manifest that records current raw/wiki/config files and hashes.

At first, it can be diagnostic:

```text
.gm/heads/current.json
.gm/manifests/<manifest_hash>.json
```

Do not yet make it authoritative. Compare it with DB/storage reality and log drift.

## Phase 4: make source mutations commit manifests

For source add/delete/config changes:

1. Stage file/object changes.
2. Write a new manifest.
3. Advance head in a DB transaction/compare-and-swap.
4. Mark projections stale.
5. Rebuild projections.

At this point, storage scans should stop resurrecting unreferenced raw files as live content.

## Phase 5: make wiki/compile output snapshot-backed

When compile publishes:

1. Write wiki files and compile snapshot files.
2. Write compile manifest with source/config/prompt/model hashes.
3. Advance vault head or compile head.
4. Rebuild `wiki_articles`, `topics`, `backlinks`, `search_index` from snapshot.

This makes accepted LLM output recoverable without relying solely on DB graph rows.

## Phase 6: move sessions to explicit hidden conversation files

Clarify the session model:

- `.gm/sessions/<id>.jsonl` is durable conversation history.
- `.gm/sessions/<id>.md` is derived readable transcript.
- `.gm/operations/replies/<id>.json` is active checkpoint.
- `raw/sessions/...` only contains promoted conversation-derived source docs.

Then update docs/code so checkpoint retention/deletion policy is enforced.

With breaking contracts and data migration permitted, [Stage 2 of the publication/export proposal](./session-publication-and-export-rewrite-proposal.md#stage-2--canonical-conversation-history-read-model-and-migration) now recommends pulling this phase's conversation-history and projection boundary forward as one scoped migration. The [Stage 2A contract/runbook](./conversation-history-contract-and-migration.md) specifies failed terminal outcomes, versioned history, and separate app-state ownership, while deliberately keeping current physical session keys for the first cut. `.gm/` relocation, the broader source/wiki manifest migration, and checkpoint/control-row garbage collection remain independent. Legacy format decoding belongs in migration/recovery tools, not a permanent dual-read runtime.

## Phase 7: prepare for encrypted sync

Once manifests define content, encrypted sync becomes easier:

- encrypt objects/packs;
- sign commits;
- upload objects before head updates;
- rebuild projections locally after pull;
- sync canonical manifests/artifacts rather than Postgres internals.

## Non-goals for early phases

- Do not port away from Postgres yet.
- Do not redesign every API response.
- Do not introduce full multi-device conflict resolution in the first step.
- Do not make object storage scans disappear before manifest checks are proven.

## Risk controls

- Keep old code paths until manifest/projection checks pass in prod-like data.
- Build repair tooling before enforcing stricter invariants.
- Add fault-injection tests around source add/delete, wiki publish, reply finalization, and config update.
- Make stale projection states visible in admin logs before surfacing to users.

## Open questions

- Is there one vault head for all content, or separate heads for source corpus, wiki compile output, and sessions?
- Should accepted compile snapshots advance the same vault head as source changes?
- How should manual external file edits be imported?
- What is the first user-visible benefit worth shipping?
- Should projection rebuild failures block reads or show stale-with-warning?
