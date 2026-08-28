# Idea Ledger — Harvested from Superseded Planning Material

**Date:** 2026-07-08

> **Status: ideas for future decisions, not commitments to execute.** Entries were verified as *not implemented*, but have **not** been vetted against the system's core algorithmic principles — in particular convergence and path-independence of incremental compiles as the raw corpus grows (e.g. frozen partition assignment or eligibility gating could make compiled output depend on ingestion order). Vet any entry against those invariants before adopting it.

Ideas, open questions, and deferred work items mined from superseded planning docs and abandoned branches (now archive tags) in the `great_minds` repo, before the material is archived. Every entry was checked against current main: it is neither implemented in the codebase nor captured in `target_architecture.md` / `docs/product-one-pager.md`. Old terminology has been translated to current (Concept→Topic, brain→vault). Coverage: `architecture_notes_and_convo_snippets.md`, `refactor_plan.md`, `upgrade_compilation_plan.md`, `context.md`, `great_minds_product_overview.pdf`, root `prompts/`, and the tags `archive/seven-phase-refactor`, `archive/six-phase-refactor`, `archive/upgrade-compilation`, `archive/converter-sidecar`, `archive/bzl`.

---

## Pipeline / Compile

**LLM lint agent authoring findings as source documents** — `architecture_notes_and_convo_snippets.md` (extended lint design discussion, ~lines 190–520) + `refactor_plan.md` M6 ("lint as evidence-producer, not architect") — Current `src/great_minds/core/lint.py` is purely mechanical (orphans, dirty topics, unmentioned links via SQL). The genesis conversation's final design adds an LLM agent that reads finished articles and writes `source_type=lint` documents flagging contradictions, too-broad topics, and missing connections; these re-enter through normal extract→abstract like any source document (the registry-mutation/approval-gate alternative was explicitly rejected as convergence-breaking). The re-entry principle is stated in target_architecture.md Principle 7, but no code implements the lint→document authoring path. `[partially-built: mechanical dirty-flagging exists; the LLM-authored finding-as-source-document half was never built]`

**Frozen partition assignment to prevent centroid drift** — `architecture_notes_and_convo_snippets.md` (~lines 293–297) — Once an idea is assigned to a partition, never reassign it on later compiles except via explicit editorial action; new ideas join existing partitions only if within the original (frozen) centroid's threshold, otherwise form new ones. Directly targets the "Partition stability" problem target_architecture.md itself flags as unresolved (k-means centroid shift causing map cache misses near cluster boundaries). `[uncertain-if-moot: current partition is unfrozen seeded k-means; this is a concrete alternative to an instability the target doc names as open]`

**Cosmetic slug-drift false-archival risk at archive time** — `refactor_plan.md` "Concept ID stability" cross-cutting note — Slug continuity across recompiles can misfire on cosmetic label drift ("Attention Mechanism" vs "Attention Mechanisms"), causing a false rename that falsely archives what is the same topic; the plan said "mitigate only if observed." Premerge's normalized-title matching operates at local-topic merge time, a different collision point from the archive-time slug-continuity check in `abstract/validate.py`, where no fuzzy-slug match exists. Directly relevant to the registry-stability work: false archival is one plausible contributor to registry-size churn. `[uncertain-if-moot: premerge covers a different stage; targeted check recommended]`

**Citable vs. context-only anchor filtering by source_type** — `refactor_plan.md` M3 — Split anchors at render into `citable` (source_type ∈ {document, user}) vs `context_only` (lint), with a post-render mechanical safety net stripping any footnote pointing at a low-trust source class even if the writer LLM ignores prompt instructions. Has no upstream producer today (the lint agent above was never built), but the belt-and-suspenders pattern — mechanical citation stripping independent of prompt compliance — is reusable for user-suggestion or other low-trust source types. `[uncertain-if-moot: depends on lint-agent revival; the pattern itself is architecture-agnostic]`

**Eligibility gating for which topics get rendered** — `upgrade_compilation_plan.md` §Deferred/Near-term — Score topics during abstract so `article_status` decides rendered vs. reference-only vs. stub, instead of rendering every canonical topic. The `ArticleStatus` enum has the shape for this but grep confirms it is only ever set to `RENDERED` or `ARCHIVED`; the original empirical motivation (~90% of subjects were singletons, most not wiki-worthy) maps directly onto today's topic registry and was never addressed. `[never-built]`

**Reconciliation/decision audit log** — `upgrade_compilation_plan.md` §Deferred/Near-term — Append-only record of every merge/split/rename decision the reducer makes, with rationale. Current publish only appends topic counts + diff to `.compile/<vault>/log.md`; there is no per-decision trail for why reduce merged/split/renamed a topic. `[never-built]`

**Redirect table for renamed/merged slugs** — `upgrade_compilation_plan.md` §Outstanding questions #3 — Multi-hop redirect resolution for topic slugs. Current schema has only single-hop `supersedes`/`superseded_by` pointers; a chain of renames (A→B→C) has no resolution path. Minor but real. `[never-built]`

**Render prompt citation-density tuning** — `upgrade_compilation_plan.md` §Outstanding questions #5 — The April renderer produced 23% shorter articles with 60% fewer links and 73% fewer footnotes than its predecessor; proposed fix was loosening "don't pad" conservatism and requiring a minimum footnote-per-paragraph density. Numbers are stale (different renderer) but the identical prompt tension ("length proportional to evidence density... don't pad", no density floor) exists verbatim in current `render.md`. `[uncertain-if-moot: empirical numbers from a retired renderer, but the qualitative question is still open against the current prompt]`

**Cross-batch re-render when new topics create backlink opportunities for unchanged topics** — `upgrade_compilation_plan.md` §Deferred/Longer-term — Detect existing articles that gain new potential link targets after an incremental compile and re-render them. Render's cache key includes `link_targets`, so this works *if* reduce re-evaluates link_targets for topics outside the changed idea set — but whether reduce's incremental input includes the full existing registry is not specified in target_architecture.md's incremental-compilation section. `[uncertain-if-moot: hinges on an unspecified property of incremental reduce]`

**Polysemy-aware split bias in the reduce prompt** — `archive/six-phase-refactor` + `archive/upgrade-compilation`, commit `807c887` "Add canonicalization pipeline with convergence tests" — The retired canonicalizer prompt explicitly handled polysemy (same label, different meaning) via a `scope_note` field and was deliberately biased toward splitting on uncertain pairs rather than merging. Current `canonicalize_registry.md`/`canonicalize_assign.md` prompts have no polysemy/disambiguation/split-bias language (grepped, no hits) — notable given the known over-merge failure mode of reduce. `[uncertain-if-moot: idea-level label+description+kind plus reduce's global view may implicitly cover it; worth checking whether reduce gets polysemy right before declaring moot]`

**Within-doc duplicate ideas from extract** — `upgrade_compilation_plan.md` §Outstanding questions #7 — Extractor can emit near-duplicate ideas within one document; no dedup guidance exists in current extract code. Low priority per the original doc, and map/reduce now consolidates globally. `[uncertain-if-moot: probably cosmetically true but consolidated away downstream]`

## Query / Retrieval

**LLM query expansion + reciprocal rank fusion** — `archive/bzl`, `src/retrieval_baseline/llama_index.py` (`_generate_queries`, `_reciprocal_rank_fusion`) — The deleted retrieval baseline generated ~3 LLM-paraphrased variants of a user question, retrieved for each, and fused ranked lists via RRF before answering. Architecture-independent recall technique; current `core/querier.py` / `core/search/` do single-query embedding retrieval only. `[never-built]`

**Topic-filtered document search** — `great_minds_product_overview.pdf`, "How the AI Finds What It Needs" (`query_documents` tool spec) — The April spec had `query_documents` filtering raw sources by tags/author/genre/date **and topics**; the current tool (`core/querier.py:292-331`) supports everything except the topic filter. Document↔topic is now indirect (document→ideas→topic_membership→topics), so this needs a join-based filter rather than a stored field — the capability was silently dropped in the concept→topic transition. `[never-built]`

## Product / UX

**Worldview vs. research mode as an explicit vault-creation toggle** — `architecture_notes_and_convo_snippets.md` (opening brain-dump + mode-specific render-prompt fork) + `refactor_plan.md` Phase 0 (explicitly deferred there too) — Two discrete modes chosen at vault creation, each forking the article-writing system prompt: encyclopedic/attributive vs. speaking-from-within-the-corpus. Current vault config (`kinds` + `thematic_hint`) has no mode field. `[uncertain-if-moot: the product later settled on "embody-as-method" as a query-time stance, which may deliberately supersede a compile-time binary toggle — but target_architecture.md doesn't mention modes at all, and the render-side fork was never considered]`

## Infra / Ops

**Agentic converter sidecar for rich-media ingest** — `archive/converter-sidecar`, commit `fb785de` "sketch: agentic converter sidecar architecture" — A separate Python 3.12 microservice exposing `POST /convert`: an LLM agent plans a bounded, single-pass tool sequence (`markitdown_convert`, `crawl4ai_extract` for JS-rendered pages, `pdfplumber_extract` for complex PDFs, `ytdlp_transcript` for video) to turn an arbitrary source into clean markdown files that enter ingest as ordinary immutable raw docs, with a `ConverterClient` fallback wired into the main app. Current ingest has plain markitdown conversion for uploaded files but no agentic planning, no web-crawl or video-transcript path. `[partially-built: markitdown file conversion + URL ingest exist in ingest_service.py; the agentic planner, crawl4ai, pdfplumber, and yt-dlp paths were never built]`

**Recipe store for domain-specific scraping** — `archive/converter-sidecar`, commit `fb785de`, README "Recipe store (future)" — Cache of human-reviewed, tested tool-call sequences per source domain (marxists.org, arXiv, Substack) so the converter agent doesn't re-plan a bespoke scrape strategy per known site. A deferred idea inside an already-shelved design; if revived it likely belongs in the separate `marxism_corpus` repo where scrapers now live. `[never-built]`

## Evaluation / Testing

**Port ad-hoc verification scripts to a real pytest suite** — `refactor_plan.md` "Testing harness" cross-cutting note, explicitly deferred as "not blocking" — `scripts/test_convergence.py`, `scripts/test_r2_storage.py`, and `scripts/test_search.py` remain ad-hoc scripts; no `tests/` directory or pytest collection exists anywhere on main, five months later. `[never-built]`

**Dev-mode / offline pipeline fixtures (no live LLM calls)** — `upgrade_compilation_plan.md` §Deferred/Documentation and tooling — Cassette/fake-LLM fixtures so extract/map/reduce/render pipeline tests run without live API calls. Grepped `tests/` for cassette/VCR/mock-LLM patterns: none exist; pipeline testing still requires real calls. `[never-built]`

**Pairwise-similarity threshold diagnostic tool** — `archive/six-phase-refactor` + `archive/upgrade-compilation`, commit `807c887` — `scripts/diagnose_canonicalize.py` printed the pairwise embedding-similarity distribution and top candidate pairs for empirical threshold tuning. No equivalent exists on main, yet target_architecture.md still lists pre-merge threshold tuning as open uncertainty #2; the histogram+top-pairs mechanism ports cleanly to tuning the current premerge Jaccard threshold. `[never-built]`

**Corpus-sampling and single-doc extract debug tooling** — `archive/six-phase-refactor`, commit `39b13ab` "Add parse retry, corpus sampling, merge-biased canonicalization" — `scripts/run_extract.py --sample/--seed` for extracting a random corpus subset, plus `scripts/debug_extract.py` for one-doc extraction with diagnostics. No sampling flag or single-doc debug script exists in current `scripts/`. `[never-built]`

---

## Confirmed dead / already covered

Checked and ruled out — fully implemented on main, fully captured in current docs, or fully moot:

**From `architecture_notes_and_convo_snippets.md`:**
- Passage/chunk-level deep-linking for citations — implemented (paragraph anchors + deep-link footnotes in `markdown.py`, `pipeline/extract.py`, `pipeline/render.py`).
- Label+description embedding for disambiguation — implemented.
- UUID7 identity / slug-vs-UUID split / kind as idea-level field — implemented as designed.
- Nested clustering by kind; structural lint mutations with approval gates — both rejected within the conversation itself; never adopted.
- Sessions/lint findings promoted as source documents (as principle) — captured in target_architecture.md Principle 7.
- Archive + supersession pointers, immutable sessions — implemented (`abstract/validate.py`, topics schema).

**Root `prompts/*.md`:** fully dead — an earlier concept+tags/single-plan-phase design predating the Idea/Anchor split; nothing novel vs. `src/great_minds/core/default_prompts/`. The `index_update.md` LLM-patch-the-index approach is inferior to current mechanical full-regen in publish.

**From `upgrade_compilation_plan.md`:**
- Topic-ID stability across re-runs — solved via slug continuity (different mechanism, same problem).
- Chunk-based passage grounding — live on main (`Anchor.chunk_index`, `#^pN` footnotes) despite being "longer-term deferred" in the doc.
- Cosine-threshold tuning for the retired canonicalizer, cluster-refinement caching, Louvain community detection, pgvector WikiSubject mirror — all moot; mechanism retired, replaced by partition + map/reduce.
- Incremental ingestion, stale-article detection, persistent cross-run IDs — implemented (`rendered_from_hash`/`compiled_from_hash`/`needs_revision`).
- Old→new compiler migration story — moot; that compiler no longer exists.

**`archive/seven-phase-refactor` (93 commits):** subsumed, not superseding — an earlier snapshot of the same line of development main continued past. Module layout matches main ~1:1; tag-only files are renames main completed later (`compile_cache/` was an empty stub, superseded by `compile_intents/`); main-only files (`pipeline_runs/`, `jobs/`, `footnotes.py`) post-date the tag. Commit-message scan for todo/defer/future/alternative found nothing. No ideas lost on this tag.

**`archive/six-phase-refactor` / `archive/upgrade-compilation`:** the latter's 8 commits are a strict prefix of the former's history. Concept-clustering canonicalizer, fuzzy crosslinker, ANN lateral-join clustering query — all architecturally superseded and documented as such. Detection-only lint, slug-archive flow, suggestion form, project switcher, scrapers, `test_convergence.py` — all present on main (convergence test rewritten for seven-phase).

**`archive/bzl`:** contains NO evaluation harness despite expectations — inspected `server.py`, `llama_index.py`, `preprocess_docs.py`: it's a web UI + query-expansion/RRF retrieval + markitdown pre-conversion cache, nothing that scores retrieval or answer quality. The llama_index/FAISS architecture itself is superseded by pgvector; only the query-expansion/RRF technique (above) is worth keeping.

**From `refactor_plan.md` / `context.md`:**
- Single ingress rail with `source_type` frontmatter (document/user/lint/session) — built (`ingest_service.py`, `documents/models.py`); the `lint` ingress value was never exercised since the lint agent never landed.
- Structured user-suggestion intent picker (DISAGREE/CORRECT/ADD_CONTEXT/RESTRUCTURE) with anchor provenance in frontmatter — built end to end: article selection popover → same-surface suggestion composer → `postUserSuggestion` → owner ingest or editor review proposal.
- UUID7 + slug-continuity identity scheme — built, carried Concept→Topic.
- Archive/supersession flow (M7) — built (`abstract/validate.py`, `superseded_by` pointers).
- documents-table split into `source_documents`/`wiki_articles` with article-ID backlinks — fully executed; `context.md` contains no unexecuted future-work items.
- Concept→Article strict 1:1 model, old 9-phase compiler, scope_note→description rename, mixed UUID5/UUID7 for ideas/anchors — all superseded by the many-to-many topics model; correctly moot.

**From `great_minds_product_overview.pdf`:** `search_wiki` (now `search_content`), `read_document`, backlinks-on-read, `query_documents` (minus topic filter), 20KB truncation threshold, role-based access + proposals, orphan detection, PDF/docx upload via markitdown, URL ingestion, graph-aware retrieval framing, sessions-as-artifacts, team-vault framing — all implemented or present in the current one-pager.

---

## Post-archival additions

**One-click typeset PDF export via Typst/WASM** — discussion 2026-07-17, not from archived material — Replace the session download menu's "download as PDF" (currently `window.print()` + print CSS, dialog-then-save) with a true one-click PDF download, compiled client-side by Typst's WASM build. Input is the canonical server rendering already served by `GET /sessions/{id}/markdown` (the "export as markdown" path); feed it through a Typst template (Typst ingests markdown via packages like cmarker), compile in a lazy-loaded web worker (~15MB WASM, ~200–400ms), download the blob. Wins: real typeset output (title page, running headers, page numbers, footnotes), zero server dependencies — deliberately avoids putting headless Chromium in the production image mid-TS-migration. Costs: a Typst template is a new styling surface separate from the print CSS, and the session markdown conventions (`# query` headings, BTW blockquotes, thinking-source labels) need mapping into it. Fallback options if Typst disappoints, ranked: Cloudflare Browser Rendering `/pdf` REST endpoint (POST print-CSS HTML, pixel-identical to today's print output, ~free at session-export volume, CF already in the account via R2); Gotenberg 8 sidecar (self-hosted Chromium in its own container). Rejected: Playwright inside the server image (~300MB bloat), @react-pdf/renderer (hand-mapped markdown, mediocre typography), client raster (jspdf/html2canvas). Keep `window.print()` as the menu's second item or drop it once the Typst path proves out. `[never-built]`

**Task-level model distillation for pipeline phases (LoRA/fine-tune)** — discussion 2026-07-09, not from archived material — Distill a cheap specialized model for a high-volume compile phase (extract is the natural candidate; compile cache already accumulates input→output pairs as free training data, `llm_costs` provides the per-phase spend signal). Explicitly rejected everywhere else in GM: per-vault knowledge/stance adapters (no provenance, retrain-per-change, per-vault ops), and retrieval-embedding tuning (past retrieval failures were corpus-quality, not encoder). Decision trigger, both required: (1) post-canonicalize-redesign, one pipeline phase dominates `llm_costs` spend; (2) a quality eval exists for that phase. Until then, frontier-model-via-OpenRouter keeps raising the buy-vs-train bar for free. `[never-built, deliberate]`
