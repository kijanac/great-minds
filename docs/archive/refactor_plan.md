# Six-Phase Compilation Refactor — Plan

Forward plan for refactoring the compilation pipeline to the target 6-phase architecture.
Builds on the current feature branch (`upgrade-compilation`); see `upgrade_compilation_plan.md`
for retrospective notes on what's already built and empirical results.

Design conversation is captured in `architecture_notes_and_convo_snippets.md`.

## Branch strategy

Branch off `upgrade-compilation`, not main. The new pipeline skeleton (extract →
canonicalize → render) is ~70% of the target; starting from main would throw it away.

## Target architecture summary

Six phases, map-reduce shape with a single global coordination point:

- **Phase 0** — Vault schema / mode config (worldview vs research). Deferred from first pass.
- **Phase 1** — Per-document cards. Ideas with nested anchors. One LLM call per doc.
- **Phase 2** — Global canonicalization. Embed `label + description`, cluster, LLM refinement.
  One Concept per cluster. 1 Concept = 1 Article always.
- **Phase 3** — Per-concept article compilation from the anchors of member Ideas only.
- **Phase 4** — Global cross-linking across wiki articles only. Does NOT touch sessions.
- **Phase 5** — Mechanical index.md assembly from Concept descriptions. Tag mirror. log.md.
- **Phase 6** — Lint: LLM agent writes `source_type=lint` source docs; dirty-flagging service.

Non-pipeline layers:
- **Sessions** — immutable. Phase 4 does not rewrite their links.
- **Archive** — retired slugs move to archive with `superseded_by` pointer. Preserves session
  link resolution without making sessions mutable.
- **BTWs** — ephemeral overlays on articles. Promotable to sessions. Sessions promotable to
  source documents (`source_type=user`), never directly to wiki.

## Key design decisions (confirmed)

1. **Mixed UUID5/UUID7 scheme.** Content-addressable IDs where derivation is stable, minted
   UUID7 with slug continuity where identity is assigned:

   | Artifact | Scheme | Basis |
   |---|---|---|
   | `documents.id` (Postgres, API) | UUID4 via `gen_random_uuid()` | Postgres-owned |
   | `document_id` (subjects pipeline, local) | UUID5 | `file_path` or content hash |
   | `idea_id` | UUID5 | `(document_id, label, kind)` |
   | `anchor_id` | UUID5 | `(document_id, claim)` |
   | `concept_id` | UUID7 | minted fresh; stability via `(brain_id, slug)` upsert lookup |

   UUID5's "free idempotency" matters primarily during full recompilation and recovery,
   not incremental. UUID7 for concepts acknowledges that concept identity is assigned,
   not derived. Slug continuity preserves the ID across free re-clustering — if the new
   canonical label produces the same slug, reuse the existing `concept_id`; if not, archive
   the old concept.

2. **Python stays on `>=3.13`.** Dependency on `uuid6>=2024.7.10` for `uuid7()`. Wrapped in
   `great_minds.core.ids.uuid7()` — single call site for a future stdlib swap if the project
   ever bumps to 3.14+.

3. **Retire old 9-phase `compiler.py`.** No parallel-and-migrate. Delete during M4.

4. **`scope_note` → `description`** — rename plus semantic shift. Positive framing
   ("what is this?") rather than defensive disambiguation. Embed `label + description` for
   clustering; description at Concept level serves Phase 3 editorial brief and Phase 5
   index.md entry.

5. **Single ingress rail.** All inputs are markdown in `raw/` with `source_type` frontmatter.
   `document` | `user` | `lint` — pipeline uniform across them.

6. **No structural registry mutations.** Editorial judgment lives only in Phase 2 clustering.
   Lint and user suggestions ride the same evidence path as any source document. No approval
   gates, no bypass paths.

7. **`compiled_from_hash`** on articles drives dirty-flagging. No version chain.

8. **JSONL authoritative**, Postgres rebuildable cache.

9. **Scratch-ID → UUID rewrite** for LLM-emitted IDs.

## Milestones

### M1 — UUID groundwork + `scope_note → description` + `Concept` model (size: M)

**Goal:** Land the target data model. No functional pipeline change; callers keep working.

**Files to modify:**
- `pyproject.toml` — add `uuid6>=2024.7.10`
- `src/great_minds/core/ids.py` (new) — `uuid7()` wrapper importing from `uuid6`
- `src/great_minds/core/subjects/schemas.py`:
  - Replace `scope_note` with `description` on `Idea` and `WikiSubject`
  - Rename `WikiSubject` → `Concept` (no alias shim; retire+rewrite)
  - Add `Concept.concept_id: UUID` (UUID7) and `compiled_from_hash: str`
  - Add `supersedes: UUID | None` and `superseded_by: UUID | None` for archive flow (M7 uses them)
  - Add `SourceType` enum (`document | user | lint`) and `SourceCard.source_type`
- `src/great_minds/core/subjects/canonicalizer.py`:
  - `_build_subject`: UUID4 → `uuid7()`; output `Concept` not `WikiSubject`
  - Embedding input: `label + description` (same text, renamed field)
  - Compute `compiled_from_hash = sha256(sorted member_idea_ids + canonical_label + description)`
- `src/great_minds/core/subjects/{service.py, renderer.py, embedding_store.py, models.py}`:
  - `scope_note` → `description` everywhere
- `src/great_minds/core/default_prompts/{source_card.md, canonicalize.md}`:
  - `scope_note` → `description` everywhere
  - Idea description prompting shifts to positive "what is this?" framing (1 sentence)
  - Concept description prompting covers editorial brief + index entry (1 sentence)
- All `scripts/` — update field names

**Schema / migration:**
- Alembic `0004_rename_scope_note_to_description.py`:
  `ALTER TABLE idea_embeddings RENAME COLUMN scope_note TO description`

**Tests:** `scripts/test_convergence.py` still passes.

**Validation:** Clean-slate `.compile/<brain>/`; extract+canonicalize+render on PSL corpus
produces articles with `concept_id` (UUID7-shaped), `description` fields, `compiled_from_hash`.
No `scope_note` references anywhere.

**Estimation:** M.

---

### M2 — Single ingress rail with `source_type` (size: S)

**Goal:** All inputs enter through `raw/` with `source_type` frontmatter. Remove bifurcated paths.

**Files to modify:**
- `src/great_minds/core/ingester.py` — `source_type` becomes a first-class frontmatter field
  with default `'document'`; accepts `'user'` and `'lint'`
- `src/great_minds/core/ingest_service.py`:
  - All ingest methods accept `source_type`
  - New: `ingest_user_suggestion(brain_id, storage, *, concept_slug, section_header, body, intent)`
    — writes structured markdown template to `raw/user/` with `source_type: user`
  - New: `ingest_lint_finding(brain_id, storage, *, finding_body)` — writes to `raw/lint/`
- `src/great_minds/core/documents/{models.py, schemas.py, repository.py}`:
  - Add `source_type: str` column (default `'document'`)
- `src/great_minds/app/api/ingest_routes.py`:
  - Accept `source_type` on ingest endpoints
  - New endpoint: `POST /brains/{brain_id}/raw/user-suggestion`

**Schema / migration:**
- Alembic `0005_add_source_type_to_documents.py`:
  `ALTER TABLE documents ADD COLUMN source_type text NOT NULL DEFAULT 'document'`

**Validation:** Ingest a fake lint finding and user suggestion; both appear in `documents`
with correct `source_type`; Phase 1 picks them up and propagates `source_type` to cards.

**Blockers:** M1.
**Estimation:** S.

---

### M3 — Phase 1/2/3 rewrite to target contract (size: L)

**Goal:** Anchors nested inline under Ideas; Concept = 1 Article strict; citation filtering
by `source_type` at Phase 3.

**Files to modify:**
- `src/great_minds/core/default_prompts/source_card.md`:
  - Output shape: `ideas: [{id, label, kind, description, anchors: [{claim, verbatim_quote}]}]`
  - Drop top-level `anchors` list
- `src/great_minds/core/subjects/service.py`:
  - `_RawExtraction` mirrors new prompt shape
  - Scratch-ID rewrite: each Idea and each Anchor get a UUID5 from their natural-key basis
  - SourceCard has no top-level `anchors`; anchors live under Ideas
- `src/great_minds/core/subjects/canonicalizer.py`:
  - Public API: `canonicalize_concepts()`
  - Refinement output: `canonical_label`, `description`, `kind`, `member_idea_ids`, `compiled_from_hash`
- `src/great_minds/core/subjects/renderer.py`:
  - Per-concept anchor gather walks `card.ideas[*].anchors` where Idea's resolved
    `concept_id == current concept.concept_id`
  - Split anchors into `citable` (source_type ∈ {document, user}) and `context_only`
    (source_type == lint)
  - Pass both to writer with prompt instruction on how to use each
- `src/great_minds/core/default_prompts/render_article.md`:
  - Add citable vs context-only distinction
  - Instruct writer not to footnote context-only anchors
- Post-render safety net: strip footnotes pointing at `source_type=lint` docs even if writer
  ignored the instruction

**Tests:**
- Update `scripts/test_convergence.py` to new shape; target: convergence numbers at or above
  current 99.95% same-data / 99.84% subset-full
- New `scripts/test_anchor_filtering.py`: `source_type=lint` anchors don't appear as footnotes
- New `scripts/test_uuid7_stability.py`: two runs of canonicalization on the same cards
  produce identical `concept_id`s via slug-continuity upsert (requires M5's table; initially
  stubbed)

**Validation:** Clean-slate `.compile/<brain>/` on PSL + Lenin 500; articles have `concept_id`
frontmatter; anchors nested in Ideas in source_cards.jsonl; no lint anchors cited.

**Blockers:** M1, M2.
**Estimation:** L.

---

### M4 — Orchestrator + retire old compiler (size: M)

**Goal:** New pipeline is the only compile path. Delete the old one.

**Files to add:**
- `src/great_minds/core/compile_pipeline.py`:
  - `async def run(storage, *, brain_id, session, limit=None) -> CompileResult`
  - Stages: `extract_phase → canonicalize_phase → render_phase → crosslink_phase (M5)
    → index_phase (M5) → archive_phase (M7) → lint_phase (M6)`
  - Return shape compatible with existing `compile_task` so API/UI don't break

**Files to modify:**
- `src/great_minds/core/workers.py` — swap `compiler.run` → `compile_pipeline.run`; drop
  old prompt partial; drop `_run_lint_and_store` (M6 replaces it)
- `src/great_minds/cli.py` — `cmd_compile` calls `compile_pipeline.run`; drop `cmd_lint`
  LLM-fix path
- `src/great_minds/app/api/lint_routes.py` — stub or delete; lint is automatic at compile end

**Files to delete:**
- `src/great_minds/core/compiler.py`
- `src/great_minds/core/default_prompts/{plan.md, reconcile.md, create_article.md,
  write_article.md, update_article.md, enrich.md, index_update.md}`
- `src/great_minds/core/linter.py` — held until M6 lands (see note under M6)

**Tests:**
- `scripts/test_compile_pipeline.py` — end-to-end dry run; articles produced; re-run is cheap

**Validation:** `great-minds compile` and the absurd worker both run new pipeline;
`grep -r "great_minds.core.compiler" src/` returns nothing (except the new `compile_pipeline.py`).

**Blockers:** M3.
**Estimation:** M.

---

### M5 — Phase 4 (cross-linking) + Phase 5 (index) + `concepts` table (size: L)

**Goal:** Cross-link wiki articles; assemble index.md mechanically; persist concept registry
for UUID7 stability.

**Files to add:**
- `src/great_minds/core/subjects/crosslinker.py`:
  - Read `wiki/*.md` only — NOT sessions/
  - Fuzzy-match canonical labels and common aliases; insert `[label](slug.md)` on first
    mention per article
  - Move broken-link validator from `renderer.py` here (`_fix_broken_wiki_links`)
  - Populate `backlinks` table (reuse existing `BacklinkORM`)
- `src/great_minds/core/subjects/indexer.py`:
  - Mechanical `wiki/index.md` assembly: group by kind, `[label](slug.md) — description`
  - Tag mirror to Postgres
  - Append to `.compile/<brain>/log.md` (run ts, diff summary, hashes)
  - No LLM call
- `src/great_minds/core/subjects/models.py` — `ConceptORM`:
  - `concept_id uuid PK, brain_id uuid, kind text, canonical_label text, slug text,
    description text, article_status text, compiled_from_hash text, supersedes uuid NULL,
    superseded_by uuid NULL, created_at, updated_at`
  - Unique: `(brain_id, slug)`
- `src/great_minds/core/subjects/concept_repository.py` — upsert helpers keyed on
  `(brain_id, slug)`: reuse existing `concept_id` if slug present, else mint new. Registry diff.

**Files to modify:**
- `src/great_minds/core/subjects/canonicalizer.py`:
  - After writing `subjects.jsonl`, upsert to `ConceptORM`. **Slug continuity logic lives here**:
    on upsert, if `(brain_id, slug)` exists, reuse its `concept_id`; else mint fresh UUID7
- `src/great_minds/core/compile_pipeline.py`:
  - Add `crosslink_phase` and `index_phase`

**Schema / migration:**
- Alembic `0006_add_concepts_table.py`

**Tests:**
- `scripts/test_crosslink.py` — cross-article link insertion works
- `scripts/test_dirty_flagging.py` — unchanged concepts skip on re-run (compiled_from_hash match)
- `scripts/test_uuid7_stability.py` (from M3, now fully exercisable) — re-run preserves
  `concept_id` when slug is stable; mints new when slug changes

**Validation:** `wiki/index.md` exists with every rendered concept; backlinks table populated;
re-compile on unchanged corpus touches zero articles.

**Blockers:** M4.
**Estimation:** L.

---

### M6 — Phase 6 lint: LLM agent writing `source_type=lint` docs + dirty-flagging (size: M)

**Goal:** Lint becomes an evidence-producer, not an architect. Delete old `linter.py`.

**Files to add:**
- `src/great_minds/core/subjects/lint.py`:
  - `async def run_lint_agent(client, *, brain_id, storage, concepts) -> list[Path]` —
    LLM reads wiki, writes substantive-prose markdown to `raw/lint/<ts>-<slug>.md` with
    `source_type: lint`. Framing discipline: NO meta-commentary. Output is primary content
    that will get extracted in the next Phase 1 run.
  - `async def flag_dirty_concepts(*, session, brain_id) -> list[UUID]` — compare
    `ConceptORM.compiled_from_hash` vs current JSONL hash
- `src/great_minds/core/default_prompts/lint.md`:
  - Explicit substantive-prose framing
  - Budget per run (e.g., 5 lint docs max initially, widenable)

**Files to modify:**
- `src/great_minds/core/compile_pipeline.py` — `lint_phase` as final stage. Writes lint
  docs but does NOT re-trigger compile in the same run. Next compile picks them up as
  normal sources.
- `src/great_minds/app/api/lint_routes.py` — either delete or repurpose for manual
  "run lint now" trigger

**Files to delete:**
- `src/great_minds/core/linter.py`
- any `_lint.json` storage handling

**Tests:**
- `scripts/test_lint_agent.py` — synthetic wiki with an obvious gap produces a substantive
  lint doc; next compile ingests it

**Validation:** Compile produces `raw/lint/*.md` with `source_type: lint`; following compile
treats them as normal sources; `linter.py` gone from tree.

**Blockers:** M5.
**Estimation:** M.

---

### M7 — Archive / supersession flow (size: M)

**Goal:** Slug churn absorbed by archive; sessions stay immutable.

**Files to add:**
- `src/great_minds/core/subjects/archive.py`:
  - `archive_retired_concepts(*, brain_id, old_registry, new_registry)`:
    - Diff `ConceptORM` against new registry
    - For retired slugs: move `wiki/<slug>.md` to `.compile/<brain>/archive/<concept_id>/<slug>.md`
    - Update `ConceptORM.superseded_by` (cheap LLM pick of best new concept)
    - Write `superseded_by: <new_slug>` to archived article frontmatter
- `src/great_minds/app/api/wiki_routes.py`:
  - `GET /wiki/archive/{concept_id}` — serve archived article
  - `GET /wiki/{slug}` — if active set miss but present in archive, return archive payload
    with supersession banner

**Files to modify:**
- `src/great_minds/core/compile_pipeline.py` — add `archive_phase` after canonicalization,
  before rendering
- `web/src/components/article-view.tsx` — render supersession banner when response has
  `superseded_by`
- `web/src/api/doc.ts` — include `superseded_by` in schema

**Tests:**
- `scripts/test_archive_flow.py` — induce registry shuffle, assert retired article moves
  to archive with resolvable supersession

**Validation:** On a corpus-modification that forces a concept rename, old slug resolves
to archive view linking to new slug.

**Blockers:** M5.
**Estimation:** M.

---

### M8 — Frontend surface updates (size: M)

**Goal:** UI aligned with new pipeline.

**Files to modify:**
- `web/src/api/{doc.ts, sources.ts}` — `source_type` in schemas
- `web/src/components/article-view.tsx` — read `concept_id` + `description`; supersession banner (M7)
- `web/src/components/sources-page.tsx`, `containers/sources-container.tsx` —
  filter by `source_type` (`document | user | lint`)
- New `web/src/components/suggestion-form.tsx` — structured template (highlight → intent picker
  → substantive text). Intent options: disagree / correct / add context / suggest restructure.
  Preserves raw user words in frontmatter for provenance.
- `web/src/pages/doc.tsx` — wire suggestion CTA to `POST /raw/user-suggestion`

**Blockers:** M2, M7.
**Estimation:** M.

---

## Cross-cutting concerns

### UUID migration strategy
Clean-slate. `.compile/<brain>/` is regeneratable from `raw/` sources. Before landing M1,
delete any existing `.compile/<brain>/` dirs and let the pipeline rebuild. No migration shims.
No dual-write period. (Confirm no irreplaceable `.compile/` state before executing.)

### `scope_note → description` rename surface
`schemas.py`, `models.py`, `service.py`, `canonicalizer.py`, `renderer.py`, `embedding_store.py`,
both prompts (`source_card.md`, `canonicalize.md`), all `scripts/`, alembic `0004`. No
frontend surface reads `scope_note` currently.

### Old compiler retirement
Safe to delete `compiler.py` in M4 once `workers.py` and `cli.py` both call
`compile_pipeline.run`. Keep `linter.py` alive through M5 (reads `_lint.json`); delete in M6.

### `source_type` propagation
Ingress (M2 frontmatter) → `documents.source_type` column → Phase 1 extractor copies into
`SourceCard.source_type` → anchors inherit from parent card → Phase 3 renderer splits
citable vs context-only → frontend filters (M8). Single field name throughout.

### Concept ID stability
**UUID7 alone is not stable across runs — slug continuity is what makes it stable.** On every
canonicalization upsert, key lookup is `(brain_id, slug)`. If present, reuse `concept_id`;
else mint fresh UUID7. Retirements flow through M7's archive, not through ID churn.
Residual risk: cosmetic slug drift ("Attention Mechanism" vs "Attention Mechanisms") causing
false rename → false archival. Mitigate only if observed.

### Alembic migration sequencing
- `0004_rename_scope_note_to_description` (M1)
- `0005_add_source_type_to_documents` (M2)
- `0006_add_concepts_table` (M5)

All additive/renaming. No destructive migrations.

### Testing harness
Convergence tests stay script-based per existing convention. Porting to pytest under `tests/`
is deferred work, not blocking.

## Risks and open questions

1. **`source_type=user` UI design** (blocks M8). Intent options and field layout need product
   spec. Backend ready after M2; frontend unblocked only with spec.

2. **Lint agent prompt quality** (M6). Substantive-prose rule is hard to enforce. Initial
   lint output may cluster into spurious concepts. Dogfood at small budget (5 docs/run);
   iterate on `lint.md`.

3. **Cross-link mechanical vs LLM-assist** (M5). Default: mechanical fuzzy-match, conservative
   thresholds. False positives expected at 2000+ concepts ("attention" everywhere). LLM
   disambiguation deferred until observed.

4. **Anchor filtering by source_type is prompt-level only**. Writer LLM may disregard. Belt-
   and-suspenders: post-render sweep strips footnotes referencing `source_type=lint` docs.

5. **Clustering convergence under new `label + description` embedding** (M3 validation).
   Current numbers are 99.95% / 99.84% on `label + scope_note`. Verify at or above under
   semantic shift. If regression, tune prompt or embedding basis.

6. **Corpus re-test after M3**. PSL (16) and Lenin (500) runs need to be repeated to confirm
   empirical results hold under anchors-nested shape.

## Summary

| Milestone | Size | Deliverable |
|---|---|---|
| M1 | M | UUID groundwork + `description` rename + `Concept` model |
| M2 | S | Single ingress rail with `source_type` |
| M3 | L | Phase 1/2/3 rewrite to target contract |
| M4 | M | Orchestrator + retire old compiler |
| M5 | L | Phase 4 crosslink + Phase 5 index + `concepts` table |
| M6 | M | Phase 6 lint as evidence-producer + dirty-flagging |
| M7 | M | Archive / supersession flow |
| M8 | M | Frontend surface updates |
