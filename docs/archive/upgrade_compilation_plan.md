# Upgrade Compilation — Progress, Open Questions, Deferred Work

Work is on branch `upgrade-compilation`.

## What's built

### Phase 1: Per-doc extraction
- `core/subjects/schemas.py`: `Idea`, `SourceAnchor`, `SourceCard`, `WikiSubject` with `SubjectKind` and `ArticleStatus` enums. Mental model: a `WikiSubject` is composed of one or more `Idea`s clustered from different source docs.
- `core/subjects/service.py`: extraction service. One LLM call per doc → structured `(doc_metadata, ideas, anchors)`. Doc-level citation — `anchor.quote` kept for writer context, no passage-level offsets (deferred).
- `default_prompts/source_card.md`: extraction prompt. Returns `ideas` with scratch IDs i1/i2, `anchors` with a1/a2; post-processor computes deterministic uuid5s.
- Parse retry (up to 2 attempts) on `JSONDecodeError` / `ValidationError` — absorbs transient LLM format noise.
- Unknown-`kind` coercion to `other` before pydantic validation.
- `scripts/run_extract.py`: CLI runner with `--sample N --seed S --limit N --concurrency N`.

### Phase 2: Canonicalization
- `core/subjects/models.py` + alembic `0003_add_idea_embeddings`: `idea_embeddings` pg table with `Vector(1024)` column, HNSW index on `(embedding vector_cosine_ops)`, brain_id btree.
- `core/subjects/embedding_store.py`: batched upsert (`ON CONFLICT DO UPDATE`), single-query ANN via SQLAlchemy `CROSS JOIN LATERAL` — pg uses HNSW per outer row, returns all threshold-passing edges in one round trip.
- `core/subjects/canonicalizer.py`: embed → upsert → top-K neighbor edges via pg → connected-components → per-cluster LLM refinement. Single-path ANN clustering, no in-memory fallback. `canonicalize()` wraps file IO; `cluster_ideas()` is the pure pipeline.
- `default_prompts/canonicalize.md`: merge-biased refinement prompt. "Default: merge. When in doubt, merge."
- Slug collision dedupe: kind suffix → subject_id hash fallback.
- Broken-link validator in renderer: strips `[label](wiki/missing.md)` to plain text.
- `scripts/run_canonicalize.py`, `scripts/diagnose_canonicalize.py`, `scripts/test_convergence.py`.

### Phase 3: Article rendering
- `core/subjects/renderer.py`: full-registry injection (works up to ~500-1000 subjects), evidence pack + full supporting-doc text (budgeted), writer emits `[label](wiki/slug.md)` + footnote citations.
- `default_prompts/render_article.md`.
- `scripts/run_render.py`: `--only-multi-doc --limit N --concurrency N --raw-link-prefix`.

## Current state — empirical results

### PSL prototype (16 docs)
- 149 ideas → 125 subjects (16% reduction)
- 13 multi-doc (10.4%), max 5 docs/subject
- 99.95% same-data rerun pair-wise agreement (convergence)
- 99.84% 8-vs-16-doc pair-wise agreement (batch-agnosticism)
- 14 multi-doc articles rendered, 141 wiki links, 0 broken after validator

### Lenin scale test (500 docs, random seed)
- 3,212 ideas → 2,012 subjects (merge-biased prompt, threshold 0.70)
- 207 multi-doc (10.3%), **max 126 docs/subject** (Soviet power)
- 90% singletons, sharp long tail
- Slug collisions: ~82 (all resolved, kind/hash suffixes)
- Extraction: 500/500 success with retry logic
- Canonicalization end-to-end: ~3 min at concurrency 40

### Comparison to old compiler (50-doc Lenin wiki, not 7K as first assumed)
- Old: 119 articles from 50 topically-concentrated docs (early Lenin economics)
- Ours: 2,012 subjects from 500 diverse Lenin docs
- Old multi-source rate: 29% (tight corpus). Ours: 10% (diverse corpus).
- Not an apples-to-apples comparison — old's high multi-source was partly corpus-focus artifact.

## Outstanding questions

1. **Is subjects = articles or is subjects a superset?**
   - Currently unresolved. 90% singletons from random-sample Lenin don't all warrant rendered wiki pages.
   - Options: render all → thin pages. Render only multi-doc + named-entities → curated wiki. Render only multi-doc → minimal. Or: subjects are queryable metadata; agent retrieves from subjects + raw, articles are a curated subset.
   - Product question, not architectural.

2. **Is 0.70 the right similarity threshold for diverse corpora?**
   - Lenin distribution: p99 = 0.568, p99.9 = 0.668. Our 0.70 is at p99.7 — quite selective.
   - 0.65 would capture 2.5x more edges (~7,355 pairs), still in legit-merge band per top-pair inspection.
   - Next empirical step: run canonicalization at 0.65 and measure multi-doc rate shift.

3. **Subject_id stability across re-runs.**
   - Currently `uuid.uuid4()` per subject. Re-canonicalization produces entirely new IDs.
   - Breaks consumer references (session metadata, future backlink tables, article frontmatter).
   - Fix: content-derived `uuid5(ns, sorted_member_idea_ids)`. Stable when cluster membership stable.

4. **Cluster refinement produces non-deterministic subject counts.**
   - Same inputs → 10-15% variance in total subject count across re-runs.
   - Caused by LLM refinement split decisions varying.
   - Fix options: cluster-signature caching of LLM outputs, temperature 0.0, or accept drift with redirect tables.

5. **Writer article quality vs old compiler.**
   - On overlapping subjects (PSL): our articles are 23% shorter, 60% fewer wiki links, 73% fewer footnotes than old_3.
   - Root cause: writer prompt "don't pad" too conservative for single-source subjects.
   - Lever: loosen prompt density constraints; require minimum footnote-per-paragraph density.

6. **Multi-source rate didn't scale with corpus size as predicted.**
   - Expected: more docs → more concept recurrence → higher multi-source.
   - Observed: PSL 10% at 16 docs, Lenin 10% at 500 docs.
   - Probably corpus-diversity artifact (random Lenin sample spans decades). Need to test on topically-focused subset to isolate.

7. **Extractor occasionally produces within-doc duplicate ideas.**
   - Observed in Lenin top-similarity pairs: same label, same doc, similar scope_note.
   - Mostly harmless (canonicalization merges them) but inflates idea count.
   - Low priority.

## Deferred work

### Near-term (post-scale-test)
- **Eligibility scoring in canonicalization.** Instead of rendering every subject, LLM-refinement step decides `article_status` (rendered | reference-only | stub). Likely drives real consolidation.
- **Writer prompt tuning.** Increase target link density + footnote density per paragraph; drop the "don't pad" guidance for multi-source subjects.
- **Content-derived subject_ids.** `uuid5(SUBJECT_NS, f"{brain_id}:{sorted_member_idea_ids}")`. Stable across re-runs.
- **Refinement caching.** Cache LLM output keyed by cluster signature (hash of member idea_ids). Eliminates stochastic drift on repeat runs.
- **Reconciliation log.** Append-only record of every merge/split/rename decision with rationale. Audit trail + drift metric input.

### Mid-term (incremental compile)
- **Incremental ingestion path.** Reuse cached idea_embeddings; only embed + canonicalize new ideas against existing subject graph. Enables cheap new-doc flow.
- **Stale-article detection.** On canonicalization, mark subjects whose member set changed as `needs_revision`. Renderer re-renders only those.
- **Persistent cross-run subject_ids** (depends on stable IDs above).

### Longer-term (deferred architecture)
- **Chunk-based passage grounding.** Shared `core/chunking.py` (paragraph-based for raw, heading-based for wiki). Extend `search_index` to cover raw-doc chunks. Anchors reference chunk_index instead of doc-level. Project memory: `project_chunk_architecture.md`.
- **Metadata-only session sidecar JSONL** (same pattern as chunks).
- **Cross-batch re-rendering for bi-directional linking.** When new docs arrive, detect existing articles that now have new referents; re-render them.
- **Graph community detection (LMCD pattern).** At very large scale (50K+ ideas), replace threshold + connected-components with LLM-judged edges + Louvain community detection.
- **Full-scale Lenin test** (7K docs). Would stress-test HNSW performance, refinement parallelism, article count management.
- **pgvector mirror of WikiSubject** for fast query-time resolution. Files authoritative; pg cache rebuildable.

### Documentation and tooling
- **API-level docs for the new compilation path** (public-facing per feedback_api_docs memory).
- **Migration story from old compiler → new.** What happens to existing `wiki/*.md` files when users switch?
- **Dev-mode fixtures** for running the pipeline without real LLM calls (offline testing).

## Open architectural bets

- **Files authoritative, pg rebuildable cache** — holding.
- **Deterministic blocking (embed + threshold + ANN) + local LLM refinement** — single-path, holding. No in-memory fallback.
- **Full-corpus canonicalization on every run** — simple; defer incremental until scale demands.
- **Doc-level citation** — prototype tradeoff; chunk-level grounding is the future direction.
- **Merge-biased refinement prompt** — fresh as of current run; initial results show modest consolidation improvement. Threshold lever pending.
