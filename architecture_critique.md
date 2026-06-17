Both deep-dive reports are in and I've verified the load-bearing claims myself (including the one "critical" bug, which is real). Here's the full critique.

  Architecture critique — Great Minds Python backend

  TL;DR: This is an unusually disciplined LLM-pipeline codebase — bounded stochastic surfaces, content-hash caching as semantics, hallucination-surface closures everywhere. The two structural weaknesses are:
  (1) the incremental-compilation story collapses at the canonicalize boundary — one new document re-rolls the canonical registry and can cascade into mass re-assignment, re-render, and article archive churn;
  and (2) the query agent is nearly blind to the graph you spent the whole pipeline building — it has three generic tools while topic_links, topic_related, backlinks, topic_membership, and idea_embeddings
  sit unused in Postgres. There's also one genuine crasher: IngestService._commit() is called four times but never defined.

  What's genuinely strong

  Worth naming because it should be preserved through the TS refactor: exactly four named stochastic surfaces with everything else mechanical; cache keys that fold in prompt + model + config so prompt edits
  self-invalidate; tag indirection (idea_1) so UUIDs never face the LLM; code-side slug derivation; the registry/assign split in canonicalize (classification framing makes assignment orphan-free by
  construction — a real fix for the over-merge failure you hit); mechanical footnote renumbering with quotes restored code-side (big token savings, zero citation-fidelity loss, render.py:622-628); link-target
  intersection closing hallucinated links; the intent/reconciler/advisory-lock orchestration is genuinely crash-safe (idempotency-keyed spawn, SKIP LOCKED, per-phase ctx.step resume).

  Correctness findings (ranked)

  1. IngestService._commit() doesn't exist — called at ingest_service.py:175,189,215,305, all inside ingest_local_files. Every local-files ingest dies with AttributeError. Verified by AST inspection.
  (Relevant to the local-first branch you're on.)
  2. Search index permanently loses chunks on embed failure. _rebuild_scope records the file's ETag in out_etags before its chunks embed (search/service.py:276), and _embed_worker drops failed batches with
  only a log (:417-423). Next compile skips the file by ETag match → those chunks are missing until the file's content changes. Unlike extract (which re-checks existing_idea_ids per compile and self-heals),
  this one never heals. Fix: only emit ETags for files whose batches committed, or reconcile counts before persisting.
  3. Query fallback restarts the conversation mid-stream. StreamStalled is retryable (llm/client.py:149) and can fire after answer tokens were already streamed; run_query then replays from base_messages on
  the fallback model (querier.py:719-726) with no "reset" event — the client gets a duplicated partial answer. Either emit a reset event or only fall back when zero content tokens have been yielded.
  4. MalformedToolArgs kills the whole stream (querier.py:633-635). Feed the parse error back as the tool result instead — models recover from this routinely. Similarly, stream_chat's while True (:617) has no
  round cap or token budget; one pathological query can loop indefinitely at your expense.
  5. Extract has no document-length guard. {doc_content} is substituted whole (extract.py:340). A book-length source overflows context → doc_failed → silently absent from the wiki, every compile. At "10K docs
  minimum cost" scale you need chunked extract with per-chunk cards merged per doc, or at least an explicit size refusal surfaced to the user.
  6. Cost events are lost on crash — accumulated in the wide-event contextvar and persisted only at request end. For long compiles, persist per-call or per-phase.
  7. Smaller: CLI compile takes no advisory lock (can race a worker compile); validate's cleanup hard-fails the compile if the LLM leaves a slug collision (validate.py:370-380) — defensible policy, but it's a
  stochastic single point of failure with a trivially safe mechanical fallback (-2 suffix + lint signal); find_active_compile scans only the last 10 tasks.

  Performance / cost

  - Chatty progress + N+1s in hot loops. Render's plan pre-pass does a sequential DB cache-get and a progress emit per topic (render.py:180-201); verify emits per article walked; _assign_topic_ids does
  get_by_slug per canonical (validate.py:397). At 200–2,000 topics this is thousands of avoidable round trips and NOTIFY writes. Batch the cache gets (one WHERE cache_key IN (...)), batch slug lookups, and
  throttle emits the way _rebuild_scope already does (every 100).
  - Two full source-card scans per compile — _estimate_tokens_by_id (partition) and _build_synthesis_index (synthesize) each stream every card. Token estimates could be persisted on the idea row at extract
  time, removing one scan.
  - Agent-loop costs grow quadratically in rounds — full history resent each round, with sort: "throughput" routing and no prompt-cache breakpoint on the stable system+history prefix. You already do prefix
  caching in canonicalize_assign; do it here too.
  - Premerge is O(N²) Jaccard — fine at 600 locals, minutes at 100K-doc scale. Bound it with an inverted index from idea_id → topics (only compare pairs sharing ≥1 idea); that's near-linear and exact for the
  same threshold.
  - query_documents' tool description embeds the entire distinct-tag vocabulary (querier.py:680-682) — unbounded prompt bloat as the corpus grows. Cap it or move tags behind a list_tags tool.

  The two big algorithmic critiques

  1. Incremental compilation collapses at canonicalize

  The registry cache key includes a signature of every local topic (canonicalize.py:363-371). Add one document → one chunk re-maps → registry cache misses → a fresh stochastic registry draw. Titles drift →
  slugs drift (slug = slugified title) → registry_sig changes → every assign batch misses (:374-381) → memberships shift → render caches miss → and validate archives every active topic whose slug wasn't
  re-emitted (validate.py:98). Your own memory records that "free re-clustering, no hysteresis" is a chosen invariant — but the only continuity mechanism is exact slug match, which is hostage to the reduce
  model's phrasing on every compile. Structurally, the marginal cost of one new document is unbounded, and so is article-identity churn (archived/superseded banners appearing on articles whose topic merely
  got re-titled "1905 Revolution" → "The Revolution of 1905").

  Options, in increasing order of invariant-bending:

  - Embedding-based slug continuity (cheap, no invariant change). In validate, before declaring a topic an archive candidate, match new canonicals to existing topics by title/description embedding similarity
  (you already have the embedding stack) and reuse the old slug/topic_id above a threshold. This alone converts most "churn" into "rename-preserving identity."
  - Anchored registry generation. Give the registry call the previous compile's canonical registry and ask for edit operations (keep / rename / merge / split / add / retire) rather than a from-scratch ToC.
  Deterministic diffs, an audit trail for log.md, and assign-batch cache stability because unchanged topics keep their exact text. This does bend "no hysteresis" — but hysteresis on identity is exactly what a
  wiki wants; users notice article churn far more than suboptimal taxonomy.
  - Major/minor compiles. Classify new locals against the existing registry (the assign machinery already does this); only run full re-derivation when a drift metric (orphan rate, coverage residual) crosses a
  threshold. Amortizes the expensive re-roll like a B-tree rebalance.

  Whichever you pick, track archive churn per compile as a first-class metric — it's currently invisible and it's the empirical question that decides this whole fork.

  2. The data model promises many-to-many; the pipeline barely delivers it

  Partition is a hard clustering — an idea lives in exactly one chunk, so it can only ever reach topics synthesized from that chunk. Assign then forces each local topic into exactly one canonical with no
  "none of these" escape (canonicalize_assign.md). So the actual ideas↔topics many-to-many comes only from synthesize multi-assigning within a single chunk. A Lenin-on-imperialism idea in the "finance
  capital" chunk can never feed the "WWI debates" article. Cheap, mechanical fix: after derive, an idea→topic augmentation pass — ANN from each idea embedding to topic centroids (mean of member-idea
  embeddings), add membership above a threshold. No LLM, cache-friendly, directly improves article evidence density. Second fix: let assign emit 1–2 slugs, and add an explicit "no good fit" output that routes
  to a residual pool feeding the next registry build (right now a genuinely novel theme that the registry missed gets misfiled rather than surfaced).

  Also: the registry LLM decides the entire wiki's table of contents from ~20 tokens per local topic (title + one line + idea count, canonicalize.py:288-292) and a hardcoded "typically 100–300" target.
  Include a few representative idea labels per local and scale the target to corpus size — these are the highest-leverage tokens in the whole pipeline.

  The query agent — biggest gap vs. your stated goal

  You want the agent "grounding itself maximally in the context of the graph, exploring it efficiently and deeply." Today it gets read_document (20K-char hard truncation, no section addressing),
  search_content (20 × 500-char snippets), and query_documents. The only graph affordance is forward-links appended to reads. Meanwhile Postgres holds topic links, Jaccard-ranked related topics, backlinks,
  idea membership, and — most valuably — idea embeddings with claims and verbatim quotes, none of it exposed. Concretely:

  - explore_topic(slug) → one call returning article body + related topics with overlap scores + backlinks + contributing source docs. One round of dense graph context instead of four shallow ones; fewer
  rounds is also your cheapest cost lever.
  - search_ideas(query) → ANN over idea_embeddings, returning [kind] label: description + claim + quote + doc path. This is a precision retrieval surface you already paid to build — claim/quote pairs are a
  far better answer substrate than 500-char paragraph snippets, and they come pre-cited.
  - Prime the system prompt with wiki/_index.md (200 topics × one line is a few KB). The agent currently starts every conversation blind, burning rounds on discovery; with the map upfront, its first tool call
  can be a targeted read. Single cheapest quality win in the repo.
  - Section-addressable reads (read_document(path, paragraph_range)) — the truncation message says "ask for a specific section" but no tool can.
  - Loop engineering: round cap + cost budget, parallel tool execution (asyncio.gather — calls are independent), tool-error feedback instead of stream abort, and prompt caching on the stable prefix.

  Also note QUERY_MODEL is DeepSeek v3.2 (providers.py:20 — the querier docstring still says Gemma). For a multi-round tool agent, this is the one place I'd consider spending up (Haiku-class or better):
  tool-call discipline compounds across rounds, and query latency/quality is the user-facing surface.

  No evaluation harness exists for either wiki or answers. You already compute the raw signals (unresolved citations, unmentioned links, orphans, churn) — promote them to a tracked per-compile scorecard, add
  a small golden Q→source retrieval set from query_logs.jsonl, and a sampled citation-faithfulness judge (does the quote actually support the claim?) using the cheap extract model. Wiki quality is the
  product; right now it's vibes plus telemetry.

  Product framing

  What you're competing with: NotebookLM (source-grounded chat, auto-organizing notebooks — closest mass-market threat), Perplexity Spaces / ChatGPT & Claude Projects (chat-over-files), Elicit/Undermind
  (papers), Glean (enterprise), Obsidian Copilot/Smart Connections (local-first, no compile). Your defensible difference is the compile artifact: a persistent, browsable wiki in open markdown with verbatim
  paragraph-anchored citations, Obsidian-compatible, local-first. Chat-over-RAG products produce answers that evaporate; you produce an asset that compounds. Two implications:

  1. Article identity stability is a product feature, not an implementation detail. A wiki whose articles get archived/renamed every compile loses precisely the "compounding asset" pitch — which is why the
  canonicalize churn issue above is the most product-critical item in this critique.
  2. The chat surface is where competitors are strongest and you're currently weakest. The graph-grounded tool set is how the compiled structure becomes visible in answers ("this connects to X, contested in
  Y, sourced from Z") — that's the demo moment chat-over-RAG can't replicate. Ingestion breadth (PDF/EPUB/web) is table stakes you'll need regardless.

  Priority order if I had to pick five: fix _commit and the ETag/embed-drop bug; add embedding-based slug continuity + churn metric; ship explore_topic + search_ideas + index priming; add agent round/budget
  caps with tool-error feedback; stand up the eval scorecard.

✻ Cooked for 12m 31s

※ recap: Critique of the Python backend is complete: two real bugs (missing _commit, ETag/embed-drop), registry churn breaking incremental compiles, and an agent blind to the graph. Next action: pick fixes to
  implement, starting with _commit. (disable recaps in /config)

✻ Claude resuming /loop wakeup (Jun 9 7:19pm)

⏺ The critique has already been delivered in full — both background reports (infra/data and orchestration/API) landed before this wakeup fired, I verified the load-bearing claims directly (confirming the
  IngestService._commit() crasher via AST inspection, the unbounded while True agent loop, and the ETag/embed-drop interaction), and the final report above covers all five requested dimensions: correctness
  (ranked findings), code quality, performance/cost, algorithmic ideas (the canonicalize re-roll cascade and the weak many-to-many delivery being the two big ones), the query agent's graph-blindness, and the
  product-competition framing against NotebookLM, Perplexity Spaces, and the chat-over-RAG field.

  Nothing remains outstanding — this wakeup was just the fallback timer. The summary of where things stand:

  - One real crasher: IngestService._commit() is undefined but called 4× in ingest_local_files (ingest_service.py:175,189,215,305).
  - One silent data-loss bug: search-index ETags persisted for files whose embedding batches failed, so missing chunks never heal (search/service.py:276 + :417-423).
  - Top algorithmic issue: one new document invalidates the canonicalize registry cache → stochastic registry re-draw → slug drift → assignment/render cache cascade + article archive churn. Cheapest fix:
  embedding-based slug continuity in validate; track archive churn as a per-compile metric to decide whether to go further (anchored registry edits or major/minor compiles).
  - Top product gap: the query agent has three generic tools while the topic graph and idea embeddings sit unused — explore_topic, search_ideas, and wiki-index priming are the highest-leverage additions.

  Happy to go deeper on any single finding (e.g., sketch the anchored-registry edit-ops prompt, or the explore_topic tool contract) whenever you want.

✻ Baked for 16s

❯ " Embedding-based slug continuity (cheap, no invariant change). In validate, before declaring a topic an archive candidate, match new canonicals to existing topics by title/description embedding similarity 
    (you already have the embedding stack) and reuse the old slug/topic_id above a threshold. This alone converts most "churn" into "rename-preserving identity."" explore further how this impacts the various 
  invariants of the product. and also tell mewhat you think about context window management generally in the app. and also about the possibility of more through tools like open_document,                      
  expand_context(chunk_id), seearch_in_document, etc                                                                                                                                                            
  ⎿  You've hit your session limit · resets 11pm (America/New_York)
     /upgrade or /usage-credits to finish what you’re working on.

✻ Cooked for 2m 3s

❯ continue                                                                                                                                                                                                      

⏺ 1. Embedding-based slug continuity — how it lands against the invariants

  Walking the invariant table from target_architecture.md one by one:

  "Stochastic surfaces are bounded and named — exactly four LLM-call types." Embedding similarity matching doesn't add a fifth in the sense the invariant cares about: there's no generation, no hallucination
  surface, the result is reproducible and cacheable given the inputs. But be honest about the gray zone — it makes a semantic judgment with a learned model, and your own experiments (the canonicalize-redesign
  memory) concluded centroid geometry fails to carve articles. The saving distinction: carving and matching are different problems. Carving is unsupervised clustering of raw ideas; matching is bipartite
  alignment between two small sets of already editorially curated texts (old topic titles/descriptions vs new ones). Embedding similarity is weak at deciding where article boundaries should be; it's quite
  reliable at recognizing that "The 1905 Revolution" and "Russian Revolution of 1905" are the same boundary.

  "Reduce is the only place that makes article-inventory decisions." Survives cleanly. The inventory — which articles exist, what they cover, their membership — is still decided entirely by canonicalize.
  Matching only decides which durable topic_id/slug a new canonical inherits. That has always been a mechanical post-pass (validate._assign_topic_ids at validate.py:388 already reassigns identity by exact
  slug match); you're widening the match function from string equality to semantic similarity, not moving the editorial decision.

  "Batch-agnosticism / convergence within a cache snapshot." No change, and this is worth stating precisely: identity was already path-dependent — get_by_slug consults the topics table, which is
  compile-history state. The convergence property has always been about registry content, with UUIDs declared opaque. Embedding matching keeps content path-independent and makes identity more stable along the
  path. One new requirement: the matching must be deterministic. Two new canonicals can both match one old topic (a split), or one new canonical can match two old topics (a merge). Use greedy one-to-one
  assignment by descending similarity with a deterministic tie-break — same discipline as _merge_undersize in partition. Residuals fall out naturally: unmatched old topics → archive candidates exactly as
  today; unmatched new canonicals → fresh UUID7 mint.

  "Sessions are immutable" — this is the invariant that benefits most. The whole reason archives carry superseded_by banners is that session links point at dead slugs. Every churn event converted from
  archive+create into rename-preserving identity is a session link that keeps resolving without a banner. On the mechanics: when matched, keep the old slug and adopt the new title/description. The slug
  becomes a stable opaque-ish identifier that may drift from the current title — which is exactly how Wikipedia URLs work, and it means the file path, backlinks, and session references all stay valid with
  zero redirect machinery. Title freshness lives in frontmatter and the index.

  The failure mode that's worse than the disease: false-positive matches. Churn at least announces itself with a banner. A wrong match silently overwrites a stable URL with content about a different theme —
  sessions now point at semantically drifted articles with no signal at all. So the threshold must be conservative, and here's the stronger move: don't lean on embeddings as the primary signal at all. Use
  idea-membership overlap. Validate already has both sets in hand — the new canonical's subsumed_idea_ids (computed at validate.py:402-406) and the old topic's topic_membership rows. If the new canonical
  shares, say, >50% Jaccard of idea evidence with an old topic, it is the same article in evidentiary terms regardless of how the registry LLM happened to phrase the title this time. That signal is fully
  mechanical (no embedding model dependency, no threshold-on-cosine hand-wringing), grounded in evidence rather than phrasing, and — crucially — robust to the registry re-roll itself: even a completely fresh
  registry draw that re-derives essentially the same partition of ideas produces near-identical membership sets. Embedding similarity then becomes the secondary signal for the case membership can't catch:
  same theme, heavily shifted evidence (big doc influx into an existing topic). Combined rule: match on membership-Jaccard > τ₁, OR (embedding-sim > τ₂ AND membership-Jaccard > small floor). This makes
  identity continuity an evidence-based property, which is philosophically the same bet the rest of the pipeline makes — corpus evidence over model priors.

  One genuine invariant tension to flag, with an optional stronger mode. Identity continuity doesn't stop re-rendering: render's cache key hashes title + description + membership (render.py:723-728), so a
  registry re-roll that rephrases a description re-renders the article even when the evidence is identical. You could add "phrasing hysteresis": when membership is identical and similarity is very high, keep
  the old title/description verbatim → render cache hit → zero cost. That does bend "free re-clustering, no hysteresis" — you'd be overriding the new registry's editorial output. My take: ship identity
  continuity first (pure win, no invariant change), instrument both archive-churn and rephrase-only-re-render rates per compile, and let the data tell you whether phrasing hysteresis earns its invariant
  violation. Don't bundle the two decisions.

  2. Context window management across the app

  The honest summary: it's deliberate in exactly one place, pragmatic in a second, and absent where it matters most.

  The deliberate place is partition — the only component in the codebase with an explicit token budget (target/min/max factors, rebalancing). Even there, note the fragility: the chars/4 estimate must mirror
  synthesize's actual prompt rendering, enforced only by a comment (partition.py:188-192). If synthesize's rendering grows a field, chunks silently overfill. The pragmatic place is render's quote elision —
  dropping verbatim quotes from the prompt and restoring them code-side killed the 1M-token failures, and it's the best context decision in the repo.

  Everywhere else, windows are unmanaged:

  - Extract: whole document substituted into the prompt with no length guard (extract.py:340). Book-length sources fail every compile, silently from the wiki's perspective.
  - Canonicalize registry: every local topic in one prompt. ~12–60K tokens at 10K-doc scale is fine; at 100K docs the hierarchical-reduce escape hatch exists in the design doc but not in code, and there's no
  guard that fails loudly when the input outgrows the window. The real ceiling isn't input anyway — it's long-output reliability: asking a model to emit a coherent 300-topic JSON registry in one generation is
  exactly the failure class that motivated the registry/assign split. The same medicine (decompose the output) will eventually be needed for the registry itself.
  - Cleanup: full canonical block + archive candidates in one call (validate.py:235-254), and it runs on most incremental compiles (any archive candidate triggers it). Grows with wiki size, unbounded.
  - Render: no cap on ideas per topic. A 500-idea mega-topic produces a bloated prompt and a diluted article. Needs an anchor budget with deterministic selection (favor doc diversity, dedupe near-identical
  claims) — or mechanical enforcement of the registry prompt's "split umbrella topics" instruction, which is currently advisory only.
  - The agent loop is the worst offender. while True with no round cap, no cumulative token accounting, and 20K-char flat-truncated reads appended every round. Ten reads is ~50K+ tokens of tool results before
  history; the loop can simply blow the model's window mid-conversation, which surfaces as a hard API error → error event to the user. There's no eviction, no summarization of stale tool results, no
  budgeting of any kind.

  What I'd build: a small shared token-budget utility (estimate, budget, trim policy) used by both the pipeline's prompt builders and the querier. In the agent loop specifically: cap rounds, track cumulative
  tokens, and when approaching budget, evict the oldest tool results in place — replace their content with a stub like [content evicted — re-read wiki/x.md if needed] while keeping the message skeleton. This
  is the standard agentic-harness pattern; it degrades gracefully instead of dying, and it pairs naturally with prompt caching since the prefix stays stable until eviction.

  3. The richer tool surface: open_document, expand_context, search_in_document

  Strong yes — and the key observation is that the data model already supports all of it; only the tools are missing. The search_index table is (path, chunk_index, heading, body, embedding). Chunk IDs exist.
  search_content computes them and then throws them away, returning anonymous snippets the agent can't follow up on. Anchors even carry chunk_index localized at extract time (_localize_anchors,
  extract.py:495-508), and rendered footnotes already deep-link as path#^pN.

  What each tool buys:

  - expand_context(path, chunk_index, before=2, after=2) — the classic small-to-big retrieval move. Search returns a 500-char snippet; the agent widens around the hit with a cheap Postgres read (bodies are
  already in the table — no storage round-trip). This is the single highest precision-per-token tool you can add: it replaces "read 20K chars of the doc hoping the passage is in the first 20K" with "read
  exactly the 5 paragraphs that matter."
  - search_in_document(path, query) — scoped hybrid search over one path; a one-line WHERE clause on the existing repo queries. This is how the agent drills into a 200K-char primary text without ever loading
  it.
  - open_document(path) — returns structure, not a dump: title, precis, author, heading outline with chunk ranges, total length, plus the first section. Converts read_document from "dump and truncate,
  mid-sentence, with a hint about sections you can't actually request" into navigation. Follow-up reads address sections or chunk ranges.
  - And the grounding loop these compose into is the product moment: agent reads a wiki claim → follows the footnote's path#^pN → expand_context around that paragraph in the primary source → quotes the
  surrounding argument back to the user. Claim → verbatim anchor → surrounding primary text, every hop mechanical and citable. No chat-over-RAG competitor can do that hop, because they don't have the anchor
  - Render: no cap on ideas per topic. A 500-idea mega-topic produces a bloated prompt and a diluted article. Needs an anchor budget with deterministic selection (favor doc diversity, dedupe near-identical
  claims) — or mechanical enforcement of the registry prompt's "split umbrella topics" instruction, which is currently advisory only.
  - The agent loop is the worst offender. while True with no round cap, no cumulative token accounting, and 20K-char flat-truncated reads appended every round. Ten reads is ~50K+ tokens of tool results before
  history; the loop can simply blow the model's window mid-conversation, which surfaces as a hard API error → error event to the user. There's no eviction, no summarization of stale tool results, no
  budgeting of any kind.

  What I'd build: a small shared token-budget utility (estimate, budget, trim policy) used by both the pipeline's prompt builders and the querier. In the agent loop specifically: cap rounds, track cumulative
  tokens, and when approaching budget, evict the oldest tool results in place — replace their content with a stub like [content evicted — re-read wiki/x.md if needed] while keeping the message skeleton. This
  is the standard agentic-harness pattern; it degrades gracefully instead of dying, and it pairs naturally with prompt caching since the prefix stays stable until eviction.

  3. The richer tool surface: open_document, expand_context, search_in_document

  Strong yes — and the key observation is that the data model already supports all of it; only the tools are missing. The search_index table is (path, chunk_index, heading, body, embedding). Chunk IDs exist.
  search_content computes them and then throws them away, returning anonymous snippets the agent can't follow up on. Anchors even carry chunk_index localized at extract time (_localize_anchors,
  extract.py:495-508), and rendered footnotes already deep-link as path#^pN.

  What each tool buys:

  - expand_context(path, chunk_index, before=2, after=2) — the classic small-to-big retrieval move. Search returns a 500-char snippet; the agent widens around the hit with a cheap Postgres read (bodies are
  already in the table — no storage round-trip). This is the single highest precision-per-token tool you can add: it replaces "read 20K chars of the doc hoping the passage is in the first 20K" with "read
  exactly the 5 paragraphs that matter."
  - search_in_document(path, query) — scoped hybrid search over one path; a one-line WHERE clause on the existing repo queries. This is how the agent drills into a 200K-char primary text without ever loading
  it.
  - open_document(path) — returns structure, not a dump: title, precis, author, heading outline with chunk ranges, total length, plus the first section. Converts read_document from "dump and truncate,
  mid-sentence, with a hint about sections you can't actually request" into navigation. Follow-up reads address sections or chunk ranges.
  - And the grounding loop these compose into is the product moment: agent reads a wiki claim → follows the footnote's path#^pN → expand_context around that paragraph in the primary source → quotes the
  surrounding argument back to the user. Claim → verbatim anchor → surrounding primary text, every hop mechanical and citable. No chat-over-RAG competitor can do that hop, because they don't have the anchor
  layer. Your pipeline paid for it already; the querier just never cashes the check.

  Two cautions:

  Tool-count tax. Every tool adds schema tokens and decision burden, and mid-tier models degrade with many overlapping tools — they start picking the wrong one or ping-ponging. Don't ship open_document +
  read_section + expand_context + read_document as four separate tools. Consolidate: one open_document(path, section=None, around_chunk=None) with optional parameters, keep the total surface at 5–6 tools
  (open_document, search_content-with-chunk-refs, search_in_document, search_ideas, explore_topic, query_documents). Descriptions matter more than count — the current search_content description is genuinely
  good; hold that bar.

  Chunk-ref stability. chunk_index is a paragraph ordinal; document edits shift it. For in-conversation use that's fine — refs are ephemeral within a query. But don't let chunk indexes leak into anything
  persistent (sessions, BTW anchors) without going through the ^pN block-ref convention the renderer already uses, or they'll rot silently. The footnote deep-links survive because they're regenerated each
  render; ad-hoc agent citations wouldn't be.

  The economics also point the same direction as the quality argument: targeted chunk reads shrink tokens-per-round and rounds-per-answer (less blind reading to find passages), which compounds with the
  eviction policy and prompt caching from the context-management section. The 20K dumps are currently the agent's dominant token cost; this tool set mostly replaces them.
