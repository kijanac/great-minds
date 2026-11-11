# Architecture

How Great Minds turns a vault's sources into a wiki, as the code runs today (November 2026). The previous version of this document described a map/reduce design that has been replaced; it is preserved in git history.

## Principles

1. **Themes are the skeleton of the wiki.** Each article covers one theme: a subject that several documents treat. The wiki is a coherent encyclopedia, not a registry of every idea.
2. **Ideas are the citation unit.** Each document is read once into ideas (a kind, a label, a description) with verbatim anchor quotes. Articles cite ideas' anchors as footnotes, so every claim traces back to a source passage.
3. **Every model answer is saved and reused.** Each question to a model is keyed by a hash of its full request (model, messages, temperature, reasoning effort, answer format). An Update asks only the questions it has never asked; everything else is read back. This is what keeps cost proportional to change and articles stable when sources don't change.
4. **Model questions are small and judgment-shaped.** Instead of one large call that decides the whole wiki, the pipeline asks many small questions: what are this document's topics; are these two topics the same; are these two themes the same entry; does this small theme belong in that article; what does this article mention; which article is that mention about; is that the best place to read about it.
5. **Failures are loud.** A question that fails is counted and reported as a warning on the run; a phase that fails stops the run with its reason. Nothing silently becomes an empty answer.
6. **Raw sources are immutable.** Feedback and suggestions re-enter as new source documents.
7. **Each vault's focus comes only from its configuration** (`thematic_hint`, `kinds`, optional enriched fields), never from wording about a particular corpus in the prompts.

## Surfaces

One HTTP API (`packages/domain` defines it, `packages/server` serves it). The web app (`web`) and `gm` command line (`packages/cli`) are sibling clients sharing `packages/client`. The server-hosted MCP adapter (`packages/server/src/mcp.ts`, `/v1/mcp`) calls the same application services as the HTTP handlers, reusing domain schemas and enforcing API-key permissions; it does not make loopback HTTP calls. Conversation export follows this same split. Operators administer a server with the `great-minds` admin CLI (`packages/server/src/main.ts`: `serve`, `migrate`, `users`, `keys`).

## Per-vault configuration

Stored as `config.yaml` in the vault:

- `kinds`: the idea taxonomy reading uses (default person, event, organization, concept; `other` is always allowed).
- `thematic_hint`: the vault's editorial focus, substituted into prompts as `{vault_focus}`.
- `enrichedFields`: optional extra per-document fields for reading to fill.

Prompts live in `packages/server/src/default_prompts/`; a vault can override any of them under `prompts/<name>.md`.

## Models

Each role has its own model, temperature and reasoning effort, configured by environment:

| Role | Used for | Settings |
|---|---|---|
| query | answers, vault hint | `QUERY_MODEL`, `QUERY_FALLBACK_MODELS`, `QUERY_TEMPERATURE`, `QUERY_REASONING_EFFORT` |
| extract | reading documents, web facts | `EXTRACT_MODEL`, `EXTRACT_TEMPERATURE`, `EXTRACT_REASONING_EFFORT` |
| map | topics, same-topic, same-entry, placement, link picks | `MAP_MODEL`, `MAP_TEMPERATURE`, `MAP_REASONING_EFFORT` |
| reduce | link check | `REDUCE_MODEL`, `REDUCE_TEMPERATURE`, `REDUCE_REASONING_EFFORT` |
| render | writing articles | `RENDER_MODEL`, `RENDER_TEMPERATURE`, `RENDER_REASONING_EFFORT` |
| embedding | search index, idea/topic/link embeddings | `EMBEDDING_MODEL` |

A model setting may name a provider (`moonshot:kimi-k3`); without a prefix it goes to OpenRouter. Providers are declared with `PROVIDERS` and `PROVIDER_<NAME>_URL`, `_KEY`, `_KIND` (`openai` or `openrouter`). Direct providers need a price in `MODEL_PRICES`. Every model and embedding call is recorded in `llm_cost_events` with its run or answer.

## Data model (main tables)

| Table | Holds |
|---|---|
| `source_documents`, `source_incarnations` | each source: identity, path, title, précis, metadata; the incarnation fences writes against concurrent deletion |
| `ideas`, `anchors` | what reading found in each document, with verbatim quotes; idea embeddings |
| `topic_proposals` | each document's topics (title, description, idea ids), with embeddings |
| `topic_candidates` | pairs of topics similar enough to ask whether they are the same |
| `topics` | the article registry: slug, title, description, status, superseded-by |
| `topic_membership` | which ideas each article covers |
| `topic_links` | article-to-article links chosen by the link step |
| `topic_related` | related articles by shared source documents |
| `wiki_articles`, `backlinks` | published articles and the links actually present in their text |
| `search_index` | passages of sources and articles, with full-text and vector search |
| `compile_cache_entries` | every saved model answer, by phase and key |
| `pipeline_runs`, `compile_intents` | runs, their stages, warnings and outcome; queued Updates |
| `llm_cost_events` | cost of every model and embedding call |

Articles are written to the vault's storage as `wiki/<slug>.md`, so the vault is directly usable as an Obsidian vault. Sources live under `raw/`.

## Pipeline

An Update runs seven phases as a durable workflow (`compile-intents.ts`); each phase is a resumable activity and checks for cancellation before it starts. Phases are in `compile-phases.ts`; the theme work is in `compile-themes-pipeline.ts` and the files it calls.

### 1. Ingest: making sources searchable (`ingest`)

Each source's markdown is split into passages and embedded into `search_index`. A source whose content hasn't changed (by ETag) is skipped. Documents whose embedding times out keep their old passages, are retried next Update, and are listed as a warning. No language-model calls.

### 2. Extract: reading sources (`compile-extract.ts`)

One question per changed document: read the whole document and return its title, précis, author, date, genre, tags and ideas with anchors (`extract` prompt, strict JSON schema built from the vault's kinds). Answers are cached by document content and prompt. New ideas are embedded. Documents that can't be read (for example, longer than the reading model's context) are listed as left out.

### 3. Abstract: finding topics, grouping themes, building articles

- **Topics** (`compile-themes.ts`, `propose_topics`): for each document with ideas, the map model names the document's topics, each with the ideas it covers. Topics are embedded.
- **Candidate pairs:** topic pairs whose embeddings are at least 0.75 similar become candidates.
- **Themes** (`judge_same_topic`): for candidate pairs, the map model answers same / related / unrelated. Topics judged the same are grouped by a pivot rule: a topic joins the group of a pivot that called it the same, without chaining through intermediaries. Each group is a theme.
- **Articles** (`compile-articles.ts`):
  - A theme covering at least 5 documents can be an article. Big themes within 0.35 embedding distance of each other, plus each big theme's 3 nearest, are asked whether they are the same entry (`judge_same_entry`); same entries merge into one article, again without chaining.
  - A smaller theme is asked whether it belongs in one of its nearest articles (`place_in_article`, up to 3 candidates within 0.4 distance); if yes it joins that article, otherwise it is left out.
- **Registry:** articles keep their existing topic id and slug where they continue an earlier article; new ones get a slug from their title. Articles that no longer exist are archived, with a pointer to the article that absorbed them when there is one.

### 4. Derive: relating articles

`topic_membership` is rebuilt from the ideas each article covers, and `topic_related` from the source documents articles share.

### 5. Render: writing and linking (`compile-write.ts`, `compile-links.ts`)

- **Writing** (`write_article`): one question per article whose content changed, with its ideas and numbered sources; the answer is the article body, and sources become footnotes.
- **Linking:** for each article, the map model lists phrases that mention other subjects (`find_mentions`); each mention is matched to candidate articles by blended text and embedding search, the map model picks one (`pick_link_target`), and the reduce model checks it is the best place to read about that subject (`check_link`). Accepted links are written into the text and recorded in `topic_links`.
- Articles are then indexed for search.

### 6. Verify: checking references

Links actually present in article text are rebuilt into `backlinks`.

### 7. Publish

Writes `wiki/_index.md` (start here and the full list) and `raw/_index.md`, records the run's outcome (articles added, changed, removed, merged) and marks the run complete.

## Incremental Updates

Because every model answer is saved by the hash of its request, an Update re-asks only what changed: new or edited documents are read; their topics are proposed; only new candidate pairs are judged; only articles whose content changed are rewritten; only changed articles are re-linked. A small change costs a small Update. Some churn remains: placing small themes can shift when neighbouring themes change, so a few articles change without any of their own sources changing.

## Known limits

- Reading sends a whole document in one request, so a document longer than the reading model's context is left out. Splitting long documents into chapters before upload avoids this; reading long documents in parts is a planned safety net.
- Duplicate subjects can still appear as separate articles: a pairwise "same?" question can't separate "same subject" from "one contains the other". Proper duplicate merging is an open design question.
- Embedding concurrency defaults to 1, so indexing a large upload is slow.
