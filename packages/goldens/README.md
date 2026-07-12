# Golden compile characterization

This package is separate from `@great-minds/parity`: parity compares HTTP contracts between two running backends, while goldens characterize the Python compile pipeline's database rows, rendered storage, cache inventory, progress taxonomy, and deferred route/state scenarios. The harness uses an isolated Compose Postgres, Alembic head, managed API/worker processes, scratch local storage, and unconditional service teardown.

## Recording and coherence

`just goldens-record` requires the recipe's `GOLDENS_RECORD=1` opt-in and an exported `OPENROUTER_API_KEY`. It is one transaction and one effective pipeline run:

1. Create an empty in-memory cassette. Record every completed provider call append-only, including duplicate normalized request hashes, in completion order. Never reuse an older cassette response in record mode.
2. Capture the cassette and golden from that same live harness execution, give both the same `recordingId`, and write them only to a private staging directory.
3. Boot a fresh database/storage/API/worker stack and replay the staged cassette immediately. Replay must report zero misses and the artifacts must pass the alpha-exact relation below.
4. Install both files with temporary names and atomic renames. If either rename or any earlier check fails, restore the previous pair; neither candidate is accepted alone.

`just goldens-check` cannot contact OpenRouter. An unknown request returns `golden_cassette_miss`; there is no statistical-envelope fallback.

The proxy preserves identity-free request semantics that UUID substitution alone cannot express at the HTTP boundary: embedding rows are associated by the provider's explicit `index`; idea and canonical-assignment positions are translated by stable content; extract responses preserve recorded completion order; duplicate live calls remain distinct; and duplicate render winners are selected for the explicitly marked first/second compile generation. These rules reproduce the response actually consumed by the recorded pipeline rather than an ordinally adjacent response.

Diagnostic instrumentation is opt-in and retained:

- `GOLDENS_DIAGNOSTIC_MISS_LOG=/path`: writes cassette-miss request bodies and hashes. Headers are never written.
- `GOLDENS_DIAGNOSTIC_REQUEST_LOG=/path`: writes request hash/path and routing outcome, never headers or successful bodies.
- `GOLDENS_KEEP_RUN_DIR=1`: preserves execution and outer recording-stage directories after failure, including the candidate cassette.

Never commit diagnostic reports or retained temporary run directories.

## Acceptance equivalence relation

This is the M4.3/M4.4 TS-port acceptance contract. Let `G` be the recorded golden and `R` a fresh replay. `G ≈ R` iff a single replay→golden UUID renaming exists and all artifacts are exactly equal after applying it and recomputing UUID-derived hashes.

The renaming is constructed from identity-free keys:

- idea UUID: framed idea-content hash of document ID, kind, label, description, and captured anchors when present;
- topic UUID: topic slug;
- article UUID: file path plus raw body hash;
- synthesized local-topic UUID: title, description, normalized subsumed idea identities, and link-target titles.

Each key must be unique on both sides, cardinalities must match, and forward and reverse maps must both be functions. A duplicate key, missing partner, collision, or many-to-one mapping is a real divergence and fails. The tested relation is reflexive, symmetric, and transitive.

After constructing the bijection, substitute UUIDs in every nested value, string, object key, frontmatter field, membership/link row, and cache value. Recompute `_topic_content_hash` from title, description, and sorted substituted idea IDs; verify each side's raw compiled hash against its own raw memberships first. Verify rendered bytes after substitution before mapping framed file/tree hashes. Pair cache entries only after their normalized values match, then extend the bijection to cache keys and exact-compare the full inventory. Canonical-assignment batches are the sole induced partition quotient: UUID sorting can move an otherwise identical local-topic assignment across the fixed 30-item boundary, so the comparator first requires the entire substituted local-topic→slug relation to be exact and functional, then canonicalizes that batch partition before the cache-key comparison.

Identity-free artifacts are never UUID-normalized: article body hashes, search-index bodies/content hashes, membership distributions, progress phase/step names, the hash-contract vectors, and deferred route/state results compare raw and exactly. Progress stores the ordered semantic SSE inventory (`phase`, raw step `key`, raw step `label`); transport polling density and numeric intermediate counters are intentionally not artifacts.

The current coherent corpus has eight anchored Markdown sources. Its first compile contains 58 ideas, 12 topics/articles, all six compile-cache phases, and seven progress phases; the incremental compile contains 14 topics and 13 articles after archive coverage.

## Scenario coverage

- First full compile and second incremental compile, including cache reuse, a stable pinned render-cache corruption, and missing-file materialization repair.
- Archive/supersede transition: rendered legacy topic with a pinned successor, no-file topic with a null successor, archived database/article rows, and archive storage move.
- Cancel mid-compile: a cassette-backed LLM response is paused, cancellation is observed, and oddity 22's unguarded `CancelledTask` failure clobber is pinned exactly.
- Staged-worker ingest route through the real worker: local-storage rejection, failed step taxonomy, and terminal error are goldenized. A successful R2 conversion batch is outside this local-storage harness and is not simulated.
- SSE capture for both compiles: connected/message/done protocol, ordered phases, exact step key/label taxonomy, and terminal state.
- Lint routes: orphan presence, dirty-topic count, and unmentioned-link presence.
- Cost routes: fixed-window user and vault aggregates across two users, two vaults, and three event types.

`pnpm --filter @great-minds/goldens record:deferred` regenerates `goldens/python-deferred.json` only from the immutable cassette. It cannot contact OpenRouter and does not alter the banked cassette/golden pair.
