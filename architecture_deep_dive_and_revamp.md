# Great Minds — Architecture Deep Dive & Revamp Proposals

> A long-form document with two jobs: (1) **deeply grok** the system as it
> exists today — every phase, table, cache key, and the invariants they
> enforce — and (2) propose **concrete, deep** revamps for scalability,
> robustness, wiki quality, and query groundedness. This is written to be
> the reference doc you reach for when deciding what to build next.
>
> Scope note: claims about code below are grounded in the current
> `src/great_minds/` tree (seven-phase pipeline, `core/pipeline/*`,
> `core/querier.py`, `core/search/*`, the orchestration layer). Where I cite
> `file.py:line`, treat it as a pointer that may drift — verify before acting.

---

## Table of Contents

- [Part I — The system as built](#part-i--the-system-as-built)
  - [1. The core bets](#1-the-core-bets)
  - [2. The data model](#2-the-data-model)
  - [3. The seven-phase pipeline](#3-the-seven-phase-pipeline)
  - [4. The incrementality & caching model](#4-the-incrementality--caching-model)
  - [5. Identity schemes](#5-identity-schemes)
  - [6. The orchestration layer](#6-the-orchestration-layer)
  - [7. The query agent](#7-the-query-agent)
  - [8. Storage, search, LLM client, telemetry](#8-storage-search-llm-client-telemetry)
- [Part II — The structural fault lines](#part-ii--the-structural-fault-lines)
  - [9. The canonicalize re-roll cascade](#9-the-canonicalize-re-roll-cascade)
  - [10. The weak many-to-many](#10-the-weak-many-to-many)
  - [11. Query-agent graph-blindness](#11-query-agent-graph-blindness)
  - [12. Context-window management](#12-context-window-management)
  - [13. Correctness bugs & robustness gaps](#13-correctness-bugs--robustness-gaps)
  - [14. Scale ceilings](#14-scale-ceilings)
- [Part III — The revamp](#part-iii--the-revamp)
  - [15. The identity & continuity layer](#15-the-identity--continuity-layer)
  - [16. Incremental compilation redesign](#16-incremental-compilation-redesign)
  - [17. Membership & the real many-to-many](#17-membership--the-real-many-to-many)
  - [18. The grounded query agent](#18-the-grounded-query-agent)
  - [19. The retrieval substrate](#19-the-retrieval-substrate)
  - [20. Context engineering as a first-class subsystem](#20-context-engineering-as-a-first-class-subsystem)
  - [21. The evaluation harness](#21-the-evaluation-harness)
  - [22. Robustness & self-healing](#22-robustness--self-healing)
  - [23. Scaling to 100K+ documents](#23-scaling-to-100k-documents)
  - [24. Cost engineering](#24-cost-engineering)
  - [25. Product positioning implications](#25-product-positioning-implications)
  - [26. A staged roadmap](#26-a-staged-roadmap)

---

# Part I — The system as built

## 1. The core bets

Great Minds is a **compiler for knowledge**. You point it at a corpus of
markdown source documents; it produces a navigable wiki of thematic articles,
each grounded in verbatim quotes from the sources, plus a chat agent that
answers questions strictly from the compiled material. The whole design rests
on a small number of deliberate bets, and almost every strength and weakness
traces back to one of them.

**Bet 1 — Ideas are the atomic citation unit.** A claim paired with a verbatim
anchor quote, extracted per-document, never rewritten, never canonicalized
across documents. Everything downstream cites ideas. This is the groundedness
foundation: because anchors are verbatim and carry a `chunk_index` into the
source paragraph, every rendered footnote can deep-link to the exact passage.
No competitor that does chat-over-RAG has this layer; it's the single most
valuable structural asset in the codebase.

**Bet 2 — Topics are the article unit, and they are thematic abstractions, not
entities.** "Lenin" is not a topic; "Lenin's theory of imperialism" is. One
topic → one article. A real-world person spans many topics; a topic spans many
people. This is a genuinely good editorial instinct — it's what makes the wiki
read like an encyclopedia of *ideas* rather than a database of *entities*.

**Bet 3 — Exactly four stochastic surfaces.** extract, map (synthesize),
reduce (canonicalize), render. Everything else is mechanical — deterministic,
testable, cacheable. This is the discipline that keeps the system debuggable.
The failure modes of LLMs are quarantined to four named places.

**Bet 4 — Content-hash caching is both optimization and semantics.** Every LLM
phase is keyed by `sha256(inputs + prompt_version + model)`. A cache hit
returns the *recorded* output. The system explicitly does **not** claim
convergence across independent LLM passes (a full recompile with the cache
cleared is a fresh recording); it claims convergence *within a cache snapshot*.
This reframing — the cache *is* the authoritative recording of "what the LLM
said about this corpus state" — is subtle and correct, and it's what makes
incremental compilation coherent at all.

**Bet 5 — Raw markdown is immutable; feedback re-enters as new source docs.**
User suggestions and lint findings don't mutate the graph; they become new
inputs to the next compile. Clean, append-only, no in-place editing of
derived state by side channels.

**Bet 6 — Local-first, open formats.** The wiki is markdown on disk
(Obsidian-compatible), sessions are JSONL + derived markdown, sidecar state is
JSONL under `.compile/`. Postgres is mostly a *cache/index* over file-layer
truth. This is the product moat: the user owns a compounding asset, not a
chat history that evaporates.

These bets are sound. The problems in Part II are almost never with the bets
themselves — they're with places where the *implementation* doesn't yet live
up to the bet (the many-to-many is promised but barely delivered), or where two
bets are in tension and the resolution hasn't been designed (free re-clustering
vs. stable article identity).

---

## 2. The data model

The authority split is the thing to internalize: **files are truth for
content-about-the-world; Postgres is a cache/index for query.** JSONL sidecars
under `.compile/<vault>/` are truth for the LLM-output recording layer.

### Postgres tables (grouped by role)

**Identity / auth / tenancy.** `users` (per-user R2 bucket name),
`auth_codes`, `api_keys`, `refresh_tokens`, `vault_memberships` (role enum),
`vaults` (owner FK, per-vault R2 bucket). Everything vault-scoped cascades on
vault delete.

**Document registry.** `source_documents` is the heart of the registry — one
row per on-disk raw file. It has three conceptual zones:
- *Identity zone*: `file_path`, `file_hash` (sha256 incl. frontmatter),
  `body_hash` (post-frontmatter), `client_hash` (browser-computed, for upload
  dedup preflight), `etag` (R2 metadata for change detection), `source_type`,
  `url`, `origin`.
- *Provenance zone* (sparse, for docs that came from sessions/suggestions):
  `provenance_session_id`, `provenance_exchange_id`, `provenance_anchored_to`,
  `provenance_intent`, etc.
- *LLM-derived zone* (NULL until extract runs): `title`, `precis`, `author`,
  `published_date`, `genre`, `tags[]`, `derived_extras` (JSONB, per-vault
  config). **Frontmatter on disk is canonical**; these columns are synced via
  `reindex_from_file()` after extract rewrites the file's frontmatter.

`wiki_articles` is the parallel registry for rendered articles — one row per
topic (`UX: topic_id`), with `file_path`, hashes, `title`/`precis` snapshots,
`render_run_id`, and `archived`. The split is deliberate: **`topics` is the
editorial plan; `documents`/`wiki_articles` is the artifact metadata index.**

`backlinks` (`source_article_id`, `target_article_id`) — derived in verify
from actual rendered prose.

**Ideas & anchors.** `ideas` (`idea_id` PK, `vault_id`, `document_id` FK,
`kind`, `label`, `description`, `embedding` pgvector 1024 — **deferred-loaded**
so corpus scans don't pull ~180MB of vectors). `anchors` (`idea_id` +
`position` PK, `claim`, `quote`, `chunk_index`). Anchor order is identity:
updates delete-and-reinsert.

**Topics & derived graph.** `topics` (`topic_id`, `vault_id`+`slug` unique,
`title`, `description`, `article_status`, `compiled_from_hash`,
`rendered_from_hash`, `supersedes`/`superseded_by`). Then three derived tables
rebuilt every compile in `derive`:
- `topic_membership` (`topic_id`, `idea_id`) — the many-to-many.
- `topic_links` (`source_topic_id`, `target_topic_id`) — *intended* citations
  from reduce's `link_targets`.
- `topic_related` (`topic_id`, `related_topic_id`, `shared_ideas`, `jaccard`) —
  for sidebar UI.

**Search.** `search_index` (`vault_id`+`path`+`chunk_index` unique, `heading`,
`body`, `content_hash`, `tsv` tsvector with GIN index, `embedding` pgvector
with HNSW index). `chunk_index = -1` is a synthetic metadata chunk
(title+precis+author) so curator summary fields are searchable alongside body
paragraphs.

**Caching & orchestration.** `compile_cache_entries`
(`vault_id`+`phase`+`cache_key` unique, `value` JSONB). `pipeline_runs`
(status, current_phase, progress_steps JSONB, LISTEN/NOTIFY trigger for SSE).
`compile_intents` (partial-unique index on pending-per-vault — the dedup
mechanism). `tasks` (absurd durable queue records). `llm_cost_events`
(per-request cost log, no indexes yet). `sessions`, `source_proposals`.

### The JSONL sidecar layer

Authoritative LLM-output recordings live at `.compile/<vault>/`:
`source_cards.jsonl` (extract output), and the per-phase cache. This is the
"recording" from Bet 4 made concrete. Postgres `ideas`/`topics`/etc. are
*derived* from these plus the file layer.

### What this buys and what it costs

The authority split is genuinely clean and is the right model for local-first.
The cost is **two sources of truth that must be kept coherent** — file
frontmatter vs. `source_documents` columns, JSONL recordings vs. Postgres
derived rows. The healing story (re-derive from truth on next compile) mostly
works, but there are gaps (see §13) where a derived row drifts from truth and
never heals because a skip-check (ETag, cache hit) prevents re-derivation.

---

## 3. The seven-phase pipeline

`compile_pipeline` / `CompileService.run()` runs:
`ingest → extract → abstract → derive → render → verify → publish`. Each phase
is wrapped in a `steps.step(...)` call so that under the absurd worker each
becomes a `ctx.step()` checkpoint (resume-from-last-completed-phase on crash);
under the CLI it's an inline pass-through.

### Phase 0 — ingest (mechanical)

`IngestPhase.run` walks `raw/`, chunks by paragraph, embeds *changed* chunks,
upserts `search_index`. Change detection is two-layer: R2 ETag skips unchanged
files entirely; within a changed file, per-chunk `content_hash` skips unchanged
paragraphs. A producer-consumer pipeline (`_rebuild_scope` in
`search/service.py`) streams files into a bounded queue, with a worker pool
sized `compile_enrich_concurrency // 10` embedding batches of 50. Stale
deletion is scoped to the path prefix (`raw/` vs `wiki/`) so rebuilding one
scope never deletes the other's rows.

### Phase 1 — extract (LLM, one call per doc)

`ExtractPhase.run` lists all registry docs, fans out `_extract_one` under a
semaphore. Per doc: cache key = `sha256(doc={id}, body_hash, prompt={hash},
model={EXTRACT_MODEL})`. On hit, the recorded `SourceCard` is returned
verbatim and only *missing* embeddings are regenerated. On miss: read body,
strict JSON-schema LLM call (per-vault schema with configured `kinds` +
`derived_extras`), mint UUID7 per idea, `_localize_anchors` substring-matches
each quote to a body paragraph to fill `chunk_index`, write cache, write
frontmatter back to disk, reindex the row. Embeddings stream in batches of 50
on `label + description`, truncated MRL to 1024 dims and L2-normalized.

The output `SourceCard`: `title`, `precis`, `author`, `published_date`,
`genre`, `tags[]`, `derived_extras`, `ideas[]` (each with `kind`, `label`,
`description`, `anchors[]`).

### Phase 2 — abstract (the heart; five sub-steps, two are LLM)

`AbstractPhase.run` threads five sub-phases:

**2a. partition (mechanical).** `PartitionPhase`. Load idea IDs (cheap), cache
key = `sha256(sorted idea_ids, target)`. On miss: estimate per-idea tokens
(chars/4 over the same shape synthesize will render), `k = ceil(total /
target_tokens)`, stream embeddings into a pre-allocated `(n, 1024)` matrix,
MiniBatchKMeans with a manual partial_fit loop (for progress + early-stop on
centroid shift), then a rebalance pass: recursively split oversize chunks by
2-means, merge undersize chunks into nearest centroid. Output: `list[list[idea_id]]`,
each chunk ≈ `target_tokens`. **Hard clustering — each idea in exactly one
chunk.**

**2b. synthesize / map (LLM, one call per chunk).** `SynthesizePhase`. Per
chunk, render ideas grouped by document with provenance (title/genre/precis/
tags), assign local tags `idea_1..idea_N` so UUIDs never face the model. Cache
key = `sha256(sorted chunk idea_ids, prompt, model)`. The LLM proposes 10–30
local thematic topics, each with slug/title/description/`subsumed_idea_ids`
(referencing the local tags). Parse maps tags back to UUIDs; unknown tags
dropped as hallucinations. **An idea can be multi-assigned within its chunk.**

**2c. premerge (mechanical).** Union-find over three exact-match signals on the
local topics from all chunks: identical slug, identical normalized title,
Jaccard(`subsumed_idea_ids`) > threshold. Unions compose. O(N²) Jaccard,
acceptable at ~600 locals. Representative donates identity; idea sets unioned.

**2d. canonicalize / reduce (LLM, two calls + batches).** `CanonicalizePhase`.
This is the redesigned reduce — split into **registry** then **assign** to fix
the over-merge failure (one-shot reduce lumped 1,800 locals into a handful of
catch-alls):
- *registry*: one LLM call over all local topics (title :: description ::
  idea-count) → the canonical article set (title + description +
  `link_targets`). Slugs derived code-side from titles for determinism.
  Cache key includes a signature of every local topic.
- *assign*: every local topic classified into exactly one canonical, in
  batches of 30, with the registry block sent as a prompt-cache breakpoint.
  Classification framing makes it **orphan-free by construction** — each local
  lands somewhere; no topic can silently swallow the corpus. Cache key per
  batch includes a registry signature so a registry change busts all batches.

**2e. validate (mechanical + one cleanup LLM call).** `ValidatePhase`. Drop
hallucinated link_targets; detect slug collisions among new canonicals and
archive candidates (existing topics whose slug vanished); if either exists, one
cleanup LLM call renames colliding slugs and picks successors for archived
topics; apply renames (hard-fail on residual collision); **slug continuity**
(`get_by_slug` → reuse `topic_id`, else mint UUID7); archive flow (set
`archived`, move `wiki/<slug>.md → archive/<topic_id>/<slug>.md`, repoint the
documents row); upsert the registry.

### Phase 3 — derive (mechanical, no cache)

Full rebuild of `topic_membership` (union of subsumed ideas across a topic's
merged locals), `topic_links` (resolved link_targets), `topic_related` (top-N
by Jaccard over idea sets). Sets `compiled_from_hash` per topic.

### Phase 4 — render (LLM, one call per topic)

`RenderPhase.run`. A pre-pass decides per topic: cache hit + file on disk →
skip; cache hit + missing file → materialize from cached body (heals deleted
files); miss → render. Cache key = `sha256(topic_id, content_hash,
sorted link_targets, prompt, model)` where content_hash =
`sha256(title, description, sorted idea_ids)`. The prompt gives the topic, its
ideas (claim + pre-assigned `[^N]` anchor number — **quotes elided**,
restored code-side), and linkable related topics. Output: `{body, tags}`.
Post-processing drops orphan footnote markers, renumbers by first appearance,
appends the footnote resolution section with verbatim quotes + deep-links
(`path#^pN`). Frontmatter added mechanically. After rendering, wiki chunks are
re-indexed into `search_index`.

### Phase 5 — verify (mechanical)

Walk rendered articles, parse actual `[title](wiki/<slug>.md)` citations, build
`backlinks` from real prose, log two lint signals (unresolved citations =
hallucinated link; unmentioned intended links = renderer diverged from reduce's
plan). The split is principled: `topic_links` is intent, `backlinks` is
reality, verify surfaces divergence.

### Phase 6 — publish (mechanical)

Write `wiki/_index.md` (TOC: title + description per rendered topic),
`raw/_index.md` (title + precis + metadata per source), append a run summary to
`.compile/<vault>/log.md` (topic counts, dirty count, chunk counts).

---

## 4. The incrementality & caching model

This is the most intellectually load-bearing part of the system, so it's worth
stating precisely what it does and does not guarantee.

**The mechanism.** Every LLM phase has a content-hash cache. The cache key
folds in the *semantic inputs* + the *prompt template hash* + the *model id*.
Editing a prompt or swapping a model auto-invalidates (the key changes; old
entries are orphaned, never read). The invalidation chain the design intends:

```
doc changes
  → extract re-runs for that doc (body_hash changed)
  → idea_embeddings updated
  → partition re-runs (idea-set hash changed)
  → chunks with changed composition → synthesize re-runs for those chunks
  → local topics change → canonicalize re-runs
  → registry changes → derive re-runs
  → topics with changed membership-hash → render re-runs
  → verify + publish re-run
```

**What it guarantees (Bet 4, precisely).** Given a cache C recording the LLM's
outputs for corpus state S, any incremental compile drawing from a subset of C
produces the same canonical topics as a full compile over C. Identity stability
comes from slug continuity (topics) and cache-returned outputs (everything
below the LLM surfaces). UUIDs are opaque.

**What it explicitly does NOT guarantee.** Convergence across independent LLM
passes. Clear the cache, recompile, and you get a fresh recording — extract,
map, reduce, render are stochastic. This is honest and correct.

**The crack (developed fully in §9).** The chain above says "chunks with
changed composition → synthesize re-runs for *those* chunks." True. But it then
says "local topics change → canonicalize re-runs" — and canonicalize's registry
cache key is a signature over **every** local topic. So *any* change to *any*
chunk's output re-rolls the entire registry. The fine-grained incrementality of
extract/partition/synthesize collapses to a coarse all-or-nothing at the
canonicalize boundary. One new document → fresh registry draw → potential
slug drift → assign cache fully busted → membership shifts → renders bust →
articles archive/churn. The incrementality is real up to phase 2c and
effectively absent from 2d onward.

---

## 5. Identity schemes

Mixed UUID5/UUID7, deliberately:

| Artifact | Scheme | Basis |
|---|---|---|
| `documents.id` (Postgres/API) | UUID4 | `gen_random_uuid()` |
| `document_id` (pipeline) | UUID5 | `(vault_id, file_path)` — stable across re-extract |
| `idea_id` | UUID7 | minted at extract; **stable only via the extract cache** |
| `local_topic_id` | UUID7 | minted at synthesize |
| `topic_id` | UUID7 | minted at canonicalize; **stable via slug continuity** |

The crucial subtlety: `idea_id` is UUID7 minted fresh on every extract *cache
miss*. So idea identity is only as stable as the extract cache. A cache hit
returns recorded ideas with their recorded IDs (stable). A miss re-mints. This
is fine for the stated design (membership is derived per-compile), but it means
**no durable cross-compile idea identity exists independent of the cache** —
which matters for any feature that wants to point at an idea over time (e.g.,
"this claim was added in compile #4").

`topic_id` stability via slug continuity is the linchpin, and §9/§15 are
entirely about how fragile "slug continuity = exact string match on a
re-generated title" turns out to be.

---

## 6. The orchestration layer

This is the most robust part of the codebase. The flow:

```
ingest route → IngestService.ingest_* → _write_and_index → _emit_compile_intent
  → compile_intents.ensure_pending(vault_id)   [partial-unique: one pending/vault]
reconciler loop (every 5s):
  → mark_satisfied: dispatched intents whose absurd task is terminal
  → dispatch_pending: oldest-first, SKIP LOCKED, skip if active compile exists,
      spawn absurd "compile" task with idempotency_key=intent_id
absurd worker (compile_task):
  → reconstruct session, acquire pg_advisory_lock(vault_id)
  → heartbeat loop (60s) extends the 120s claim
  → build_compile_service(absurd_step_runner) → run() → per-phase ctx.step
  → on exception progress.fail(); always release lock
```

**Idempotency is layered and genuinely crash-safe:**
- Concurrent ingests coalesce to one pending intent (partial-unique index).
- Intent→task spawn dedups on `idempotency_key=intent_id` (safe to retry the
  spawn if the process dies between spawn and mark_dispatched).
- Document writes are content-addressed (`raw/docs/<hash>.md`) and upsert on
  `(vault_id, file_path)`.
- The vault advisory lock serializes compiles; a second compile blocks until
  the first releases.
- A zombie detector marks pipeline runs stale after 120s in active state.

**Resume semantics.** Because each phase is a `ctx.step`, a worker crash
resumes from the last completed phase, not from scratch. A 10-hour compile that
dies in verify resumes at verify. Side effects within a phase must be
idempotent (they mostly are, via upserts + content-addressed writes).

**The gaps** (detailed in §13): `IngestService._commit()` is referenced but —
wait, this was verified to *exist* in the current tree contrary to one report;
the real bugs are the CLI-vs-worker lock asymmetry, the search ETag/embed-drop
interaction, and a few smaller races.

---

## 7. The query agent

`querier.py`. A streaming tool-use loop (`stream_chat`) with three tools:
- `read_document(path)` — read a wiki article or raw source. **Hard-truncates
  at 20,000 chars** with a "ask for a specific section" hint (but no tool can
  honor that request). Appends forward-links extracted from the content.
- `search_content(query)` — hybrid BM25 + vector + RRF over `search_index`,
  returns up to 20 results as `### filename > heading\n{500-char snippet}`.
- `query_documents(...)` — structured metadata filter (tags/author/genre/date)
  over raw docs. The tool *description* embeds the entire distinct-tag
  vocabulary.

System prompt is three layers: a non-overridable retrieval-discipline core +
identity block (focus, article/source counts), the per-vault `query` persona
prompt, and (in BTW mode) a conciseness addendum, plus optional per-request
instructions. History is real multi-turn (`HistoryMessage[]`). For
article-anchored BTW, the origin doc is pre-loaded via a synthetic tool-call
pair.

The loop: `while True` → stream a model round → if finish_reason is tool_calls,
run them, append results, continue → else emit `done` with `sources_consulted`.
Cross-model fallback on retryable errors (rate limit, stream stall) by
restarting from `base_messages` on the next model.

**The gap (developed in §11/§18):** the agent has three *generic* tools and is
nearly blind to the graph the pipeline built. `topic_links`, `topic_related`,
`backlinks`, `topic_membership`, `idea_embeddings` (with claims + verbatim
quotes) — none are exposed. The agent rediscovers structure by reading
documents that already encode it, burning rounds and tokens.

---

## 8. Storage, search, LLM client, telemetry

**Storage** is a clean async `Protocol` (read/write/exists/glob/append/mkdir/
delete/clear) with `LocalStorage` and `R2Storage`. Local glob returns
`etag=None` (forces re-index every compile — fine locally). R2 wraps boto3 in
`asyncio.to_thread`, gets ETags free from listing. Path traversal is guarded
via `_resolve().is_relative_to(root)`. `.compile/` sidecar paths bypass Storage
(local fs under data_dir).

**Search** is hybrid BM25 (`ts_rank` over GIN tsvector) + vector
(`cosine_distance` over HNSW) merged by Reciprocal Rank Fusion (K=60). Index
build is the producer-consumer pipeline described in Phase 0, with ETag + chunk
content-hash change detection and scoped stale deletion.

**LLM client** (`llm/client.py`) is three layers: `api_call` (429 retries ×6
honoring Retry-After, generic retries ×2 with jittered backoff, OpenRouter
`usage.include` for cost), `api_stream` (per-chunk 30s stall detection,
single-model — fallback is the caller's job), `json_llm_call` (one JSON-parse
retry, fence stripping). Models: extract/map/query = DeepSeek v3.2,
reduce/render = Qwen 3.6 Plus, embeddings = qwen3-embedding-8b (1024 MRL).

**Telemetry** is wide-events with correlation IDs; cost accumulates into a
contextvar during a request and is persisted once at request end
(`record_wide_event_cost`).

---

# Part II — The structural fault lines

## 9. The canonicalize re-roll cascade

**This is the most important architectural problem in the system**, because it
defeats both scalability (the marginal cost of one new doc is unbounded) and
product quality (article identity churns).

### The mechanism, precisely

`canonicalize._registry_cache_key(ordered, prompt_hash, thematic_hint)` hashes
`_local_sig(t)` for *every* local topic `t` (title, description, idea-count).
So the registry cache hits only if the entire local-topic set is byte-identical
to a prior compile. Add one document:

1. extract runs for the new doc (1 LLM call) — correct, incremental.
2. partition re-runs because the idea-set hash changed. k-means centroids
   shift; chunk *composition* changes near boundaries — not just the new
   ideas' chunk, but neighboring chunks too.
3. synthesize re-runs for every chunk whose composition changed (could be
   several, not one).
4. The local-topic set changes → **registry cache miss → a fresh stochastic
   registry draw.**
5. The new registry has different titles → different code-derived slugs →
   `registry_sig` changes → **every assign batch cache misses** (all ~N/30
   reduce calls re-run).
6. Membership shifts (ideas land in differently-named topics).
7. Render cache key (includes title, description, membership hash) changes for
   many topics → **mass re-render**.
8. validate sees many existing slugs absent from the new canonical set →
   **mass archive**, each with a `superseded_by` banner.

So the cost of "add one document" ranges from "one extract call + a few
re-synthesizes" (the incremental ideal) to "re-roll the registry + all assign
batches + most renders + archive churn" (the actual worst case), and **which
one you get is decided by the reduce model's phrasing stability**, which is not
something you control.

### Why slug continuity doesn't save you

`validate._assign_topic_ids` does `repo.get_by_slug(vault_id, c.slug)` → reuse
`topic_id` if the slug exists. But the slug is `_slugify(title)`, and the title
is freshly generated by the registry LLM every re-roll. "The 1905 Revolution"
this compile, "Russian Revolution of 1905" next compile → different slug → no
match → mint new UUID7 → the old topic becomes an archive candidate. Identity
continuity is hostage to exact string stability of a stochastic generation.

### The product consequence

The compounding-asset pitch (§25) dies if articles churn. A user who bookmarks
`wiki/the-1905-revolution.md`, or whose session links to it, finds it archived
behind a supersession banner after the next compile — not because the content
changed, but because the model rephrased a title. Worse, sessions are immutable
(a correct invariant) so they *keep* pointing at the archived path. The banner
machinery exists precisely because this churn happens; the right fix is to make
the churn not happen.

### Why this is subtle

The memory note `project_canonicalize_experiments` records that centroid
geometry fails to carve articles — so there's a learned instinct that
"embedding approaches don't work here." But carving (unsupervised clustering of
raw ideas into article boundaries) and *matching* (aligning two sets of already
curated topic descriptions) are different problems with different difficulty.
The fix in §15 leans primarily on **idea-membership overlap**, which is even
more robust than embeddings and sidesteps that concern entirely.

---

## 10. The weak many-to-many

The data model (`topic_membership`, "ideas ↔ topics is many-to-many") promises
that one idea can inform multiple articles. The pipeline barely delivers it:

- **partition is hard clustering.** Each idea is in exactly one chunk
  (`_group_by_label` + rebalance). An idea can therefore only be seen by the
  synthesize call for its chunk, and can only ever join topics proposed from
  that chunk's contents.
- **assign is single-target.** `canonicalize_assign.md` instructs "Assign EACH
  sub-topic to exactly ONE article." `_parse_assignments` keeps one slug per
  local. So a local topic — and transitively its ideas — reaches exactly one
  canonical.

The only real source of an idea reaching multiple topics is *within-chunk*
multi-assignment in synthesize. So a "Lenin on finance capital" idea that
landed in the "imperialism" chunk can never feed the "WWI debates" article,
even if it's directly relevant — because the two themes were carved into
different chunks and the idea was never visible to the WWI synthesize call.

This caps article evidence density and cross-linking quality. Articles are
thinner than the corpus could support, and the `topic_related` graph (built
from shared ideas) under-counts true relatedness because ideas don't spread.

There's also an **orphan vs. misfile** problem: assign forces every local into
some canonical with no "none of these fit" escape. A genuinely novel theme the
registry missed gets *misfiled* into the nearest article rather than surfaced
as a gap. The orphan-free-by-construction property — a strength against
catch-all swallowing — becomes a weakness against novelty detection.

---

## 11. Query-agent graph-blindness

The pipeline computes a rich graph and the agent ignores almost all of it.
Sitting unused in Postgres at query time:

- `topic_links` — intended citations between articles.
- `topic_related` — Jaccard-ranked relatedness with shared-idea counts.
- `backlinks` — real article-to-article links from rendered prose.
- `topic_membership` — which ideas inform which article.
- `idea_embeddings` — **the crown jewel**: every idea with its `kind`, `label`,
  `description`, and verbatim `claim`/`quote` anchors, embedded and ANN-indexed.

The agent instead gets `read_document` (20K-char flat truncation),
`search_content` (anonymous 500-char snippets), `query_documents`. To answer
"how does X connect to Y," it must read both articles in full and infer the
connection that `topic_links`/`topic_related`/`backlinks` already state
explicitly. To ground a claim, it gets a paragraph snippet rather than the
pre-extracted claim/quote pair that *is* the citation.

This is the biggest lever on the product's headline capability (groundedness +
deep graph exploration) and it's almost entirely unbuilt. §18 is the concrete
fix.

## 12. Context-window management

Deliberate in exactly one place (partition's token budget), excellent in a
second (render's quote elision), absent everywhere it matters:

- **extract**: whole document substituted, no length guard. Book-length
  sources overflow → `doc_failed` → silently absent from the wiki, every
  compile.
- **canonicalize registry**: all locals in one prompt; the real ceiling is
  long-*output* reliability (a 300-topic JSON registry in one generation is
  the failure class the registry/assign split was invented to fix — and the
  registry call still does exactly that for the registry itself).
- **cleanup**: full canonical block + archive candidates, runs on most
  incremental compiles, grows unbounded with wiki size.
- **render**: no cap on ideas per topic; a 500-idea mega-topic bloats the
  prompt and dilutes the article.
- **the agent loop**: `while True`, no round cap, no token accounting, 20K-char
  reads appended every round. Ten reads = 50K+ tokens of tool results before
  history. The loop can blow the model's window mid-conversation → hard API
  error → error event to the user. No eviction, no summarization, no budgeting.

## 13. Correctness bugs & robustness gaps

Verified against the current tree:

1. **Search index loses chunks permanently on embed failure.** `_rebuild_scope`
   records a file's ETag in `out_etags` *before* its chunks embed; the
   ingest phase persists those ETags (`refresh_etag_batch`). `_embed_worker`
   drops failed batches with only a log. Next compile skips the file by ETag
   match → missing chunks never heal until the file's content changes. Unlike
   extract (which re-checks `existing_idea_ids` and self-heals), this one is
   permanent. **Fix:** only emit ETags for files whose batches committed, or
   reconcile chunk counts before persisting the ETag.

2. **Query fallback restarts the conversation mid-stream.** `StreamStalled` is
   retryable and can fire *after* answer tokens streamed; `run_query` replays
   from `base_messages` on the fallback model with no reset event → the client
   sees a duplicated partial answer. **Fix:** only fall back when zero content
   tokens have been yielded, or emit an explicit reset event.

3. **Malformed tool args kill the whole stream.** `MalformedToolArgs` aborts.
   **Fix:** feed the parse error back as the tool result; models recover.

4. **Unbounded agent loop** (§12). No round/token cap.

5. **No document-length guard in extract** (§12).

6. **Cost events lost on crash** — accumulated in a contextvar, persisted once
   at request end. Long compiles that crash lose all cost telemetry. **Fix:**
   persist per-call or per-phase.

7. **CLI compile takes no advisory lock** — can race a worker compile on the
   same vault. **Fix:** acquire the same lock or document as unsafe.

8. **validate cleanup hard-fails the compile on residual slug collision** — a
   stochastic single point of failure with a trivially safe mechanical
   fallback (`-2` suffix + lint signal).

9. **Stale ideas on extract config change** — `bulk_upsert` uses ON CONFLICT DO
   UPDATE keyed on `idea_id`; ideas that vanished between extractions for a
   cache-hit doc are not deleted (only cache-miss docs get `delete_for_documents`).
   Low-likelihood (needs a config change) but pollutes membership.

## 14. Scale ceilings

At the design's stated 10K-doc target the system is fine. The ceilings that
appear well before 100K docs:

- **premerge O(N²)** Jaccard over all locals — minutes-to-hours as locals grow.
- **canonicalize registry one-shot** — both input (all locals) and output
  (the full registry) outgrow a single call; the design's "hierarchical reduce"
  escape exists on paper, not in code.
- **per-topic / per-doc N+1s** — render's plan pre-pass does a sequential cache
  GET + progress emit per topic; `_assign_topic_ids` does `get_by_slug` per
  canonical; verify emits per article. Thousands of round trips + NOTIFY
  writes at scale.
- **two full source-card scans per compile** (partition token estimate +
  synthesize index build).
- **the re-roll cascade (§9)** makes *every* incremental compile pay near
  full-compile cost on the canonicalize→render tail.

---

# Part III — The revamp

The rest of this document is concrete proposals. They're ordered roughly by
leverage, and they compose — the identity layer (§15) unlocks the incremental
redesign (§16); the retrieval substrate (§19) unlocks the grounded agent (§18).

## 15. The identity & continuity layer

**Goal:** make article identity an *evidence-based* property that survives
registry re-rolls, so the marginal compile stops churning the wiki. This is the
keystone fix — everything in §16 depends on it.

### The core idea: match on idea-membership, not slug strings

Today identity continuity = exact slug match. Replace it with a **bipartite
matching pass in validate**, before archive candidates are declared, using two
signals already in hand:

1. **Membership Jaccard (primary).** A new canonical `C_new` has resolved
   `subsumed_idea_ids` (computed at `validate._assign_topic_ids`). Each existing
   topic `T_old` has `topic_membership` rows. If
   `|ideas(C_new) ∩ ideas(T_old)| / |ideas(C_new) ∪ ideas(T_old)| > τ₁`,
   they are the *same article* in evidentiary terms — regardless of how the
   registry LLM phrased the title this time. This is robust to the re-roll
   itself: a fresh registry draw that re-derives essentially the same partition
   of ideas produces near-identical membership sets, so the match holds.

2. **Embedding similarity (secondary).** For the case membership can't catch —
   same theme, heavily shifted evidence (a big doc influx grew the topic) —
   compare `embed(title + description)` of `C_new` against `T_old`. Match if
   `cos > τ₂ AND membership_jaccard > floor` (the floor prevents a purely
   lexical match with zero evidentiary overlap).

### The algorithm (deterministic)

```python
def match_canonicals_to_existing(new_canonicals, existing_topics):
    # Build candidate edges with scores.
    edges = []  # (score, new_idx, old_topic_id)
    for ni, c in enumerate(new_canonicals):
        c_ideas = set(c.subsumed_idea_ids)
        for t in existing_topics:               # active (non-archived) only
            j = jaccard(c_ideas, membership[t.topic_id])
            if j > FLOOR:
                sim = cos(embed(c.title, c.description), t.embedding)
                score = primary_score(j, sim)   # e.g. max(j, j>0 and sim weighting)
                if j > TAU1 or (sim > TAU2 and j > FLOOR):
                    edges.append((score, ni, t.topic_id))
    # Greedy one-to-one by descending score, deterministic tie-break.
    edges.sort(key=lambda e: (-e[0], str(e[2]), e[1]))
    matched_new, matched_old, assignment = set(), set(), {}
    for score, ni, tid in edges:
        if ni in matched_new or tid in matched_old:
            continue
        assignment[ni] = tid
        matched_new.add(ni); matched_old.add(tid)
    return assignment   # new_idx -> existing topic_id (reuse slug + id)
```

Greedy one-to-one with a deterministic tie-break keeps it reproducible (same
discipline as `_merge_undersize`). Splits (two new canonicals matching one old
topic) and merges (one new matching two old) resolve naturally: the
highest-scoring edge wins the identity; the loser mints fresh or archives.

### What "match" does

When `C_new` matches `T_old`:
- **Reuse `T_old.topic_id` and `T_old.slug`.** The slug is now a stable,
  opaque-ish identifier that may drift from the current title — exactly how
  Wikipedia URLs work. File path, backlinks, sessions all stay valid with zero
  redirect machinery.
- **Adopt the new title/description** into frontmatter + the index. Title
  freshness lives in metadata; URL stability lives in the slug.
- Unmatched new canonicals → mint fresh UUID7 (genuinely new articles).
- Unmatched old topics → archive candidates, exactly as today (genuinely
  retired themes).

### Embeddings precomputed, not on the fly

Add a `topics.embedding` column (pgvector 1024), set in validate/derive from
`embed(title + " — " + description)`. Then matching is a cheap in-DB
`cos` per candidate pair, no synchronous embed calls in validate.

### Invariant impact (the careful part)

- *"Exactly four stochastic surfaces."* **Preserved.** Matching is mechanical
  and reproducible; no generation, no hallucination surface. The membership
  signal isn't even a learned model. (Embedding similarity uses a model but for
  *alignment of curated texts*, not for *carving* — the thing the experiments
  showed fails.)
- *"Reduce is the only place that makes article-inventory decisions."*
  **Preserved.** Which articles exist + their membership is still 100%
  canonicalize. Matching only decides which durable id/slug a canonical
  *inherits* — already a mechanical post-pass.
- *"Batch-agnostic / convergent within a cache snapshot."* **Preserved and
  strengthened.** Identity was already path-dependent (`get_by_slug` consults
  compile history). Matching keeps registry *content* path-independent and makes
  *identity* more stable along the path.
- *"Sessions immutable."* **This is the big winner.** Every churn event
  converted from archive+create into rename-preserving identity is a session
  link that keeps resolving without a banner.

### The danger: false-positive matches

A wrong match silently overwrites a stable URL with content about a *different*
theme — worse than churn, because churn at least announces itself with a banner.
Mitigations: (a) make membership the primary, conservative signal (evidence
overlap is hard to fake); (b) require the membership floor even for embedding
matches; (c) **log every match decision** (old slug, new title, j, sim, score)
to `log.md` and a `topic_identity_events` table so the decisions are auditable
and the thresholds tunable; (d) start τ₁ high (e.g. 0.5) and loosen with data.

### Optional stronger mode: phrasing hysteresis

Identity continuity stops churn but **not re-rendering**: render's key hashes
title + description + membership, so a re-roll that merely rephrases a
description still re-renders an evidentially identical article. Add an opt-in:
when membership is identical and similarity very high, **keep the old
title/description verbatim** → render cache hit → zero cost. This *does* bend
"free re-clustering, no hysteresis" (you override the new registry's editorial
phrasing). Recommendation: **ship identity continuity first** (pure win, no
invariant change), instrument `archive_churn_rate` and `rephrase_only_rerender_rate`
per compile, and let data decide whether phrasing hysteresis earns the
violation. Don't bundle the decisions.

---

## 16. Incremental compilation redesign

With the identity layer in place, attack the re-roll cascade itself so the
marginal compile cost tracks the marginal corpus change.

### Option A — Anchored registry edits (recommended)

Replace the from-scratch registry generation with an **edit-operation** model.
Feed the registry LLM the *previous* canonical registry plus the *new/changed*
local topics, and ask for a diff:

```
Previous registry (N topics): [slug, title, description, idea_count] each
New & changed local topics since last compile: [...]

Return operations:
  { "keep":   ["slug", ...] }                              # unchanged
  { "rename": [{"slug": "...", "title": "...", "desc": "..."}] }
  { "merge":  [{"into": "slug", "from": ["slug", ...]}] }
  { "split":  [{"slug": "...", "into": [{title, desc}, ...]}] }
  { "add":    [{title, desc, link_targets}] }
  { "retire": ["slug", ...] }
```

Why this is better:
- **Stable text → stable cache.** Unchanged topics keep byte-identical
  title/description → their assign batches and renders cache-hit. Only the
  touched region re-runs.
- **Identity falls out for free.** `keep`/`rename`/`merge`/`split` all carry
  the old slug(s) explicitly — no fuzzy matching needed (though §15 stays as a
  safety net for when the LLM drops a topic it should have kept).
- **Audit trail.** The op list *is* the `log.md` diff — exactly the registry
  drift the log is meant to show.
- **Bounded output.** The model emits operations proportional to the *change*,
  not the whole registry, sidestepping the long-output reliability ceiling.

Cost: the model must see the previous registry (input grows with wiki size).
Mitigate with prompt-cache breakpoint on the stable previous-registry block
(you already do this in assign).

This bends "convergence across independent passes" further toward
"convergence along the compile path" — but that was never claimed, and
path-stable identity is what a wiki *wants*.

### Option B — Major / minor compiles

Borrow B-tree rebalancing. Most compiles are **minor**: classify new locals
against the *existing* registry (the assign machinery already does exactly
this), add memberships, render only new/dirty topics. No registry re-roll. Run
a **major** compile (full re-roll + §15 reconciliation) only when a drift
metric crosses a threshold:

```
drift = w1 * orphan_rate(new locals not fitting any existing topic)
      + w2 * coverage_residual(ideas with no good topic)
      + w3 * fraction_of_corpus_added_since_last_major
trigger major when drift > THRESHOLD (or on explicit user "reorganize")
```

This amortizes the expensive re-roll. Day-to-day ingestion is cheap and
non-churning; periodic majors keep the taxonomy healthy. Pair with §15 so even
majors don't churn identity.

**Recommendation:** build Option A first (it directly fixes the cascade and
gives identity for free), keep Option B's drift metric as the *trigger* for
when an anchored edit should be allowed to do bigger restructuring (merge/split)
vs. pure keep/add.

### Make partition incremental too

The cascade starts at partition (centroids shift → chunk composition churns →
synthesize busts). Two mechanical fixes:
- **Sticky assignment:** seed k-means with previous centroids; assign new ideas
  to nearest existing chunk if within radius, only re-cluster when a chunk
  exceeds the token budget. Most compiles then touch one or two chunks, not all.
- **Stable chunk identity:** key synthesize on a chunk's *content hash* (sorted
  idea_ids) as today, but make partition *try* to preserve chunk composition so
  that hash is stable for untouched corpus regions. The design doc already
  notes stable regions cache-hit; sticky centroids make that the common case
  rather than the lucky case.

---

## 17. Membership & the real many-to-many

Deliver the many-to-many the data model promises, mechanically and cheaply.

### Idea→topic augmentation pass (post-derive, no LLM)

After derive builds `topic_membership` from the assign output, run an ANN
augmentation:

```python
# Topic centroid = mean of member-idea embeddings (already have them).
for topic in topics:
    topic.centroid = normalize(mean(embed[i] for i in membership[topic]))
# For each idea, find topics whose centroid is close, add membership.
for idea in ideas:
    for topic_id, sim in ann_topics(embed[idea], k=5):
        if sim > AUGMENT_TAU and topic_id not in membership_of(idea):
            add_membership(topic_id, idea, source="augmented")
```

This lets the "Lenin on finance capital" idea reach the "WWI debates" article
without ever having shared a chunk with it. Mark augmented memberships with a
`source` column (`assigned` vs `augmented`) so render can weight them (primary
evidence vs. supporting) and so you can measure their effect. Fully cacheable
(keyed on idea-set + centroid hash), no LLM.

### Multi-target assign + a residual pool

Two prompt/parse changes to canonicalize:
- Let assign emit **1–2 slugs** per local with a primary/secondary distinction.
  Ideas spread along genuine thematic overlap rather than being force-fit to
  one bucket.
- Add an explicit **"no good fit"** output. Locals that don't fit route to a
  *residual pool* surfaced to the next registry build (or to lint as "themes
  the taxonomy is missing"). This converts the orphan-free-by-construction
  property from "novelty gets misfiled" into "novelty gets surfaced" — without
  reintroducing catch-all swallowing (the residual is explicit, not a dumping
  ground inside an existing article).

### Richer registry input

The registry LLM decides the entire ToC from ~20 tokens per local (title + one
line + idea count). Give it more signal where it's cheap:
- Include 2–3 representative idea *labels* per local (the highest-leverage
  tokens in the pipeline — they're what the article is actually *about*).
- Scale the "typically 100–300 articles" target to corpus size
  (`target ≈ clamp(total_ideas / ideas_per_article, 50, 1000)`), don't hardcode.

---

## 18. The grounded query agent

The headline product capability. The pipeline already paid for a rich graph and
a precision citation layer; the agent just needs to cash the check. **The data
model already supports all of this — only the tools are missing.**

### The new tool surface (consolidated to ~6 tools)

Keep the count low — mid-tier models degrade with many overlapping tools.
Descriptions matter more than count.

**1. `search_ideas(query)` — the precision retrieval surface.**
ANN over `idea_embeddings`. Returns, per hit:
`[kind] label: description` + the `claim` + the verbatim `quote` + the source
`path#^pN` deep-link. This is a *far* better answer substrate than 500-char
paragraph snippets: claim/quote pairs *are* the citation, pre-extracted and
pre-anchored. The agent can quote and cite in one hop.

**2. `explore_topic(slug)` — the graph affordance.**
One call returns: article body + `topic_related` (with shared-idea counts) +
`backlinks` (who cites this) + `topic_links` (who this intends to cite) +
contributing source docs (from `topic_membership` → ideas → documents). One
round of dense graph context replaces four shallow `read_document` rounds.
This is the tool that makes the compiled structure *visible* in answers ("this
connects to X, is contested in Y, and is sourced from Z") — the demo moment
chat-over-RAG can't replicate.

**3. `open_document(path, section=None, around_chunk=None)` — navigation, not
dumping.** Default returns *structure*: title, precis, author, heading outline
with chunk ranges, total length, plus the first section. With `section` or
`around_chunk`, returns that slice. Converts the 20K flat truncation into
addressable reading. Replaces today's `read_document`.

**4. `expand_context(path, chunk_index, before=2, after=2)` — small-to-big
retrieval.** `search_*` returns a tight hit; the agent widens around it with a
cheap Postgres read (bodies are already in `search_index` — no storage round
trip). Highest precision-per-token tool you can add: "read exactly the 5
paragraphs that matter" instead of "read 20K chars hoping the passage is in the
first 20K."

**5. `search_in_document(path, query)` — scoped drill-down.** Hybrid search
constrained to one path (a one-line `WHERE path = ?`). How the agent
interrogates a 200K-char primary text without loading it.

**6. `query_documents(...)` — keep, but fix the unbounded tag vocabulary.**
Move the tag list behind a `list_tags()` call or cap it; don't inline the whole
vocabulary into the tool description (unbounded prompt bloat as the corpus
grows).

### The grounding loop this enables

```
search_ideas("does Lenin think imperialism is inevitable?")
  → idea with claim + quote + raw/.../imperialism.md#^p42
explore_topic("lenins-theory-of-imperialism")
  → article + related: "kautsky-ultra-imperialism" (contested), backlinks
expand_context("raw/.../imperialism.md", 42)
  → the surrounding argument in Lenin's own words
→ answer: claim, with the verbatim anchor, the contesting position, and a
   link the user can follow to the primary source.
```

Claim → verbatim anchor → surrounding primary text, every hop mechanical and
citable. No competitor has the anchor layer to do this.

### Prime the system prompt with the map

The agent starts every conversation blind and burns rounds on discovery. Inject
`wiki/_index.md` (200 topics × one line ≈ a few KB) into the system prompt. The
first tool call becomes a *targeted* `explore_topic`/`open_document` instead of
a blind `search_content`. **Single cheapest quality win in the repo.** For large
wikis, inject a clustered/section view rather than the full flat list.

### Model & loop engineering

- `QUERY_MODEL` is DeepSeek v3.2 (the querier docstring still says Gemma —
  stale). For a multi-round tool agent, tool-call discipline compounds across
  rounds; this is the one place to consider spending up (a stronger
  tool-calling model). Query quality/latency is the user-facing surface.
- **Round cap + token budget** in `stream_chat` (kill the unbounded `while
  True`).
- **Parallel tool execution** — tool calls in a round are independent; run them
  with `asyncio.gather`, not sequentially.
- **Tool-error feedback** — return parse/exec errors as tool results, don't
  abort the stream.
- **Prompt caching** on the stable system+history prefix (you do this in
  canonicalize_assign already).
- **Fallback only before first content token** (fixes bug §13.2).

---

## 19. The retrieval substrate

The agent tools in §18 are only as good as what they retrieve over. Three
substrate upgrades:

### Ideas as a first-class retrieval index

`idea_embeddings` is currently used only for partition. Expose it for query
(`search_ideas`). It's the best retrieval target in the system because each row
is a *self-contained, pre-cited, atomic claim*. Add a lightweight
`idea → topic(s) → article` join so a found idea can offer "read the article
that synthesizes this" as a follow-up.

### Chunk-ref stability discipline

`chunk_index` is a paragraph ordinal; document edits shift it. For
*in-conversation* use that's fine (refs are ephemeral within a query). But never
let raw chunk indexes leak into anything persistent (sessions, BTW anchors)
without going through the `^pN` block-ref convention the renderer already uses —
or they rot silently. Footnote deep-links survive because they're regenerated
each render; ad-hoc agent citations wouldn't.

### Hybrid retrieval tuning + reranking

RRF with K=60 over BM25 + vector is a fine default, but:
- Add an optional **cross-encoder rerank** of the top ~50 fused results before
  returning 20 — cheap, big precision gain for the agent's first hop.
- **Weight the metadata chunk** (title/precis/author, `chunk_index=-1`) higher
  — a title match is a stronger signal than a body-paragraph match.
- Consider **query expansion** for `search_ideas` (the embedding model is cheap)
  — embed a couple of LLM-generated paraphrases and union the ANN results.

---

## 20. Context engineering as a first-class subsystem

Today context management is ad hoc. Make it a small shared utility used by both
the pipeline prompt builders and the querier.

### A token-budget utility

```python
class TokenBudget:
    def estimate(text) -> int          # tiktoken or chars/4, one source of truth
    def fits(parts, limit) -> bool
    def trim(parts, limit, policy) -> list  # drop/summarize/elide by priority
```

Use it in:
- **extract**: refuse or chunk documents over a body-token threshold; surface
  the refusal to the user (don't silently fail). For over-long docs, chunked
  extract → per-chunk cards → merge ideas per doc.
- **canonicalize/cleanup**: enforce input ceilings, trigger the hierarchical
  path when exceeded (instead of silently overflowing).
- **render**: anchor budget per topic — deterministic selection favoring
  document diversity and deduping near-identical claims; enforce the registry
  prompt's "split umbrella topics" instruction mechanically rather than as
  advice.

### Agent-loop context lifecycle

The pattern that makes long agent conversations survive:
- **Round cap + cumulative token accounting.**
- **Evict oldest tool results in place** when approaching budget: replace the
  content with a stub (`[content evicted — re-read wiki/x.md if needed]`) while
  keeping the message skeleton intact. Degrades gracefully instead of dying;
  pairs naturally with prompt caching since the prefix stays stable until
  eviction.
- **Summarize on overflow** as a fallback: a cheap-model pass that compresses
  the older turns into a running brief, preserving citations.
- **Structure-first reads** (§18) mean tool results are smaller to begin with —
  the cheapest form of context management is retrieving less.

---

## 21. The evaluation harness

You can't tune §15–§20 without measurement, and there's currently no eval for
either wiki or answers. The signals already exist; promote them to tracked
metrics.

### Compile scorecard (per compile, into `log.md` + a table)

- **Identity churn:** `archive_churn_rate` (archived / total), `rename_rate`,
  `rephrase_only_rerender_rate`. These are the §15/§16 success metrics.
- **Coverage:** fraction of ideas with ≥1 membership; orphan/residual rate.
- **Link health:** unresolved-citation rate, unmentioned-intended-link rate
  (already logged in verify — aggregate them).
- **Evidence density:** mean anchors/article, mean source-docs/article.
- **Cost:** $/compile, $/article, cache-hit rates per phase.

### Citation faithfulness judge (sampled)

For a sample of rendered footnotes, an LLM-judge (cheap extract model) checks:
does the verbatim quote actually support the claim it's attached to? This is the
groundedness guarantee, measured. Track `faithfulness_rate`.

### Query eval set

Build a golden set from `query_logs.jsonl`: question → expected source
document(s). Measure retrieval recall@k for `search_ideas`/`search_content`, and
an LLM-judge answer-quality score (grounded? cites correctly? admits gaps?).
Run it on every querier change. This is how you justify spending up on
`QUERY_MODEL` or adding a reranker.

### Regression gating

Wire the scorecard into CI on a small fixture corpus. A change that spikes
archive churn or drops faithfulness fails the build. Wiki quality is the
product; right now it's vibes plus telemetry — make it a tracked number.

---

## 22. Robustness & self-healing

### Fix the verified bugs (§13)

In priority order: search ETag/embed-drop (permanent data loss) → agent loop
caps + tool-error feedback + fallback-before-first-token → extract length guard
→ per-call cost persistence → CLI advisory lock → cleanup mechanical fallback →
stale-idea deletion on cache-hit config change.

### Make "heal on next compile" universal

The system's robustness story is "derived state re-derives from truth." It
holds *except* where a skip-check prevents re-derivation (the ETag bug is the
archetype). Audit every skip-check (extract cache, partition cache, synthesize
cache, render cache, search ETag) for the property: **a skip must imply the
derived state is actually present and correct, not merely that the input is
unchanged.** The search ETag violates this (input unchanged ≠ chunks present).
The fix pattern: skip only when (input unchanged) AND (a cheap presence check
on the derived rows passes).

### Idempotency completeness

The orchestration layer is strong. Two additions:
- A periodic **reconciliation sweep** that re-derives presence invariants:
  every rendered topic has a wiki file + search chunks; every raw doc has
  search chunks; every topic has membership. Emit lint for violations and
  optionally auto-repair (re-render, re-index). This catches the long tail of
  "drifted but didn't heal."
- **Cost durability** (above) so a crashed compile doesn't lose its spend
  record — important once compiles cost real money at scale.

### Partial-failure semantics

Per-doc extract and per-topic render already log+skip individual failures and
retry naturally next compile (good). Make this explicit and visible: a
`compile_health` summary (`X/Y docs extracted, Z topics failed`) surfaced in the
UI, not just logs, so a user knows their wiki is 98% complete and which 2% to
investigate.

---

## 23. Scaling to 100K+ documents

The design targets 10K docs; here's what changes at 10×–100×.

### Premerge: O(N²) → near-linear

Replace the all-pairs Jaccard with an **inverted index** from `idea_id →
[local_topic]`. Only compare pairs that share ≥1 idea (the only pairs that can
have nonzero Jaccard). Exact same result, near-linear in practice.

### Canonicalize: hierarchical reduce, for real

The design's escape hatch, implemented: cluster local topics by
description-embedding into super-clusters; run registry-per-cluster; then a
final registry over the sub-canonical outputs. Combine with the anchored-edit
model (§16) so the top-level reduce sees a stable prior structure rather than
re-deriving global structure from scratch. Track the quality cost (top-level
reducer loses global view) via the §21 scorecard.

### Kill the N+1s

- Render plan pre-pass: one `WHERE cache_key IN (...)` batch GET instead of N
  sequential gets; throttle progress emits to every K (as `_rebuild_scope`
  already does).
- `_assign_topic_ids`: one batched `WHERE slug IN (...)` instead of per-slug
  `get_by_slug`.
- verify: batch the article reads and emit progress every K.

### Eliminate redundant scans

Persist per-idea token estimates on the idea row at extract time → partition
skips its dedicated token-estimate scan. Consider whether synthesize's index
build can share partition's already-loaded data within a single compile (pass
the matrix/cards forward rather than re-streaming).

### Embedding & DB scale

- HNSW is fine to millions of rows; monitor recall vs. `ef_search` as vectors
  grow, and consider per-vault partitioning of `search_index`/`ideas` if a
  single vault gets huge.
- Batch embedding throughput: the producer-consumer pool is good; make
  concurrency adaptive to observed rate limits rather than a fixed
  `//10` divisor.

### Compile parallelism across vaults

The advisory lock serializes *per vault* (correct). Across vaults, the absurd
worker pool scales horizontally. Ensure the reconciler dispatch + worker pool
sizing don't bottleneck multi-tenant throughput; the reconciler's
`find_active_compile` scanning only the last 10 tasks (§13) should become a
direct "active compile for vault?" query.

---

## 24. Cost engineering

At "$17 budget / $40 quality per 10K-doc compile," the cost structure is
dominated by extract (1 call/doc) and render (1 call/topic). Levers:

- **The re-roll fix (§16) is the biggest cost lever** — it turns most
  incremental compiles from "re-pay the canonicalize→render tail" into "pay only
  for what changed." This dwarfs per-call optimizations.
- **Prompt caching everywhere a stable prefix exists**: extract (the rendered
  template is identical across docs — cache it as a breakpoint), render (no
  shared prefix per topic, but the instruction block is constant), the agent
  loop (§18). You already do it in assign; generalize.
- **Tiered models with measured fallback**: extract/map on the cheapest viable
  model (DeepSeek), reduce/render on quality models *only when the scorecard
  says prose quality matters*. Use the faithfulness judge to decide where a
  cheaper model is acceptable.
- **Embedding cost is negligible but reads add up** — cache query embeddings for
  repeated/similar queries.
- **Cost attribution** (the per-call durability fix) lets you see $/article and
  $/query and optimize the actual hotspots rather than guessing.
- **Augmentation over re-synthesis (§17)** — getting many-to-many from a
  mechanical ANN pass instead of more/larger LLM calls is free density.

---

## 25. Product positioning implications

**What you're competing with:** NotebookLM (source-grounded chat,
auto-organizing notebooks — closest mass-market threat), Perplexity Spaces /
ChatGPT & Claude Projects (chat-over-files), Elicit/Undermind (papers), Glean
(enterprise), Obsidian Copilot / Smart Connections (local-first, no compile).

**Your defensible difference is the compile artifact**: a persistent, browsable
wiki in open markdown with verbatim paragraph-anchored citations,
Obsidian-compatible, local-first. Chat-over-RAG produces answers that
evaporate; you produce an asset that compounds. Three implications that should
drive engineering priority:

1. **Article identity stability is a product feature, not an implementation
   detail.** A wiki whose articles churn every compile loses precisely the
   "compounding asset" pitch. This is why §15/§16 are the most product-critical
   work in this document, not just the most technically interesting.

2. **The chat surface is where competitors are strongest and you're currently
   weakest.** The graph-grounded tools (§18) are how the compiled structure
   becomes *visible* in answers — "this connects to X, contested in Y, sourced
   from Z." That's the demo moment chat-over-RAG structurally cannot replicate,
   because they don't have the topic graph or the anchor layer. Build it and it
   becomes the headline.

3. **Groundedness is the trust moat.** The claim/quote/deep-link chain
   (§18 grounding loop) is verifiable in a way that "the model said so" never
   is. Measure it (§21 faithfulness judge), surface it (every answer
   click-throughs to the primary source), and market it. For research/scholarly
   users — your primary use case — verifiability is the whole game.

Ingestion breadth (PDF/EPUB/web at scale) is table stakes you'll need
regardless; it's a prerequisite, not a differentiator.

---

## 26. A staged roadmap

Ordered to front-load product-critical, dependency-unlocking work.

**Stage 0 — stop the bleeding (days).**
Fix the verified bugs: search ETag/embed-drop (data loss), agent loop caps +
tool-error feedback + fallback-before-first-token, extract length guard,
per-call cost persistence. Add the §21 scorecard skeleton so everything after
is measurable.

**Stage 1 — identity & incrementality (weeks).**
Ship §15 membership-based identity continuity + `topics.embedding` +
`topic_identity_events` audit. Instrument archive churn. Then §16 Option A
(anchored registry edits) with §15 as the safety net. This is the keystone:
it fixes the cascade, the cost, and the product-critical churn at once.

**Stage 2 — the grounded agent (weeks).**
Ship §18: `search_ideas`, `explore_topic`, `open_document`/`expand_context`/
`search_in_document`, index-priming, loop engineering, parallel tools. Stand up
the §21 query eval set. This is the headline product upgrade.

**Stage 3 — quality & density (weeks).**
§17 idea→topic augmentation + multi-target assign + residual pool + richer
registry input. §19 reranking. §20 context-budget utility across pipeline +
agent. Faithfulness judge live.

**Stage 4 — scale (as needed).**
§23: premerge inverted index, hierarchical reduce, N+1 elimination, redundant
scan removal, partition stickiness, multi-tenant throughput. Driven by actual
corpus growth, gated by the scorecard.

The throughline: **measure first (Stage 0 scorecard), fix identity (Stage 1) so
the wiki becomes a stable compounding asset, make that asset visible and
verifiable in chat (Stage 2), then deepen quality and scale.** Identity and
groundedness are the two things competitors can't copy; everything else is
table stakes or optimization.
