# Golden compile characterization

This package is separate from `@great-minds/parity`: parity compares HTTP contracts between two running backends, while goldens characterize the Python compile pipeline's database rows, rendered storage, cache inventory, progress taxonomy, and deferred route/state scenarios. The harness uses an isolated Compose Postgres, Alembic head, managed API/worker processes, scratch local storage, and unconditional service teardown.

## Recording and coherence

`just goldens-record` requires the recipe's `GOLDENS_RECORD=1` opt-in and an exported `OPENROUTER_API_KEY`. It is one transaction and one effective pipeline run:

1. Create an empty in-memory cassette. Record every completed provider call append-only, including duplicate normalized request hashes, in completion order. Never reuse an older cassette response in record mode.
2. Capture the cassette and golden from that same live harness execution, give both the same `recordingId`, and write them only to a private staging directory.
3. Boot a fresh database/storage/API/worker stack and replay the staged cassette immediately. Replay must report zero misses and the artifacts must pass the alpha-exact relation below.
4. Install both files with temporary names and atomic renames. If either rename or any earlier check fails, restore the previous pair; neither candidate is accepted alone.

`just goldens-check` cannot contact OpenRouter. An unknown request returns `golden_cassette_miss`; there is no statistical-envelope fallback.

`pnpm --filter @great-minds/goldens regenerate` is also cassette-only. It boots the same fresh isolated stack as check, replays the immutable banked cassette steered by the previous golden (identity fixtures and the pinned `repairRenderHeading` carry forward, so the corruption target stays stable across regenerations), captures a fresh snapshot from that replay, then validates the candidate with a second coherence replay (alpha-exact comparison, zero misses, alpha fallbacks bounded by the previous banked baseline) before stamping the cassette's existing `recordingId` and atomically installing the regenerated golden. It never enables record mode or contacts OpenRouter; replay modes are not handed the live API key at all.

The proxy preserves identity-free request semantics that UUID substitution alone cannot express at the HTTP boundary: embedding rows are associated by the provider's explicit `index`; idea and canonical-assignment positions are translated by stable content; extract responses preserve recorded completion order; duplicate live calls remain distinct; and duplicate render winners are selected for the explicitly marked first/second compile generation. These rules reproduce the response actually consumed by the recorded pipeline rather than an ordinally adjacent response.

Every final result reports `proxyStats`: cassette entries, raw request-body hits, alpha/content-routing fallbacks, and misses. The content-routing tiers are Python-replay concessions for composing fresh UUID identities only. M4.4 TS-backend acceptance requires `misses === 0` and `alphaFallbacks === 0`: raw-hit tier only. Check also fails when Python replay exceeds the banked non-raw baseline.

`normalizeArchiveFixture` pins the fixed archive fixture's two cleanup decisions at the proxy seam: the rendered legacy topic receives a current canonical successor and the no-file topic receives `null`. This normalization makes both archive branches stable while leaving Python responsible for archive detection, persistence, and file movement; it is fixture normalization, not a claim that cleanup-model choice is deterministic.

Diagnostic instrumentation is opt-in and retained:

- `GOLDENS_DIAGNOSTIC_MISS_LOG=/path`: writes cassette-miss request bodies and hashes. Headers are never written.
- `GOLDENS_DIAGNOSTIC_REQUEST_LOG=/path`: writes request hash/path and routing outcome, never headers or successful bodies.
- `GOLDENS_KEEP_RUN_DIR=1`: preserves execution and outer recording-stage directories after failure, including the candidate cassette.

Never commit diagnostic reports or retained temporary run directories.

## Acceptance equivalence relation

This is the M4.3/M4.4 TS-port acceptance contract. Let `G` be the recorded golden and `R` a fresh replay. `G ≈ R` iff a single replay→golden UUID renaming exists and all artifacts are exactly equal after applying it and recomputing UUID-derived hashes. The M4.4 TS goldens mode will pin the identity stream through an injectable `RandomBytesService`, use a deterministic clock, and run pipeline concurrency at `1`; those controls make each TS run internally deterministic and alpha-exact against the golden. The selectable backend seam that replaces the harness's current hard-coded Python API/worker launch is an M4.3 deliverable. No artifact class is expected to require non-exact TS checking.

The renaming is constructed from identity-free keys:

- idea UUID: framed idea-content hash of document ID, kind, label, description, and captured anchors when present;
- topic UUID: topic slug;
- article UUID: file path plus raw body hash;
- synthesized local-topic UUID: title, description, normalized subsumed idea identities, and link-target titles.

Each key must be unique on both sides, cardinalities must match, and forward and reverse maps must both be functions. A duplicate key, missing partner, collision, or many-to-one mapping is a real divergence and fails. The tested relation is reflexive, symmetric, and transitive.

After constructing the bijection, substitute UUIDs in every nested value, string, object key, frontmatter field, membership/link row, and cache value. Recompute `_topic_content_hash` from title, description, and sorted substituted idea IDs; verify each side's raw compiled hash against its own raw memberships first. Verify rendered bytes after substitution before mapping framed file/tree hashes. Independently reconstruct partition, synthesize, canonicalize-registry, canonicalize-assign, and render cache keys from their contract inputs; extract keys must match verbatim because document UUIDs are pinned. Key pairing remains as a bijection-consistency check only after construction passes. Canonical-assignment batches are the sole induced partition quotient: UUID sorting can move an otherwise identical local-topic assignment across the fixed 30-item boundary, so the comparator first requires the entire substituted local-topic→slug relation to be exact and functional, then canonicalizes that batch partition before the final inventory comparison.

Identity-free artifacts are never UUID-normalized: article body hashes, search-index bodies/content hashes, membership distributions, progress phase/step names, the hash-contract vectors, and deferred route/state results compare raw and exactly. Progress stores the ordered semantic SSE inventory (`phase`, raw step `key`, raw step `label`); transport polling density and numeric intermediate counters are intentionally not artifacts.

The current coherent corpus has eight anchored Markdown sources. Its first compile contains 58 ideas, 12 topics/articles, all six compile-cache phases, and seven progress phases; the incremental compile contains 14 topics and 13 articles after archive coverage.

## Scenario coverage

- First full compile and second incremental compile, including cache reuse, a stable pinned render-cache corruption, and missing-file materialization repair.
- Archive/supersede transition: rendered legacy topic with a pinned successor, no-file topic with a null successor, archived database/article rows, and archive storage move.
- Cancel mid-compile: a cassette-backed LLM response is paused, cancellation is observed from the job state, and oddity 22's Python `CancelledTask` handler clobber is pinned explicitly with `clobberedBy: "python"`.
- Staged-worker ingest route through the real worker: local-storage rejection, failed step taxonomy, and terminal error are goldenized. A successful R2 conversion batch is outside this local-storage harness and is not simulated.
- SSE capture for both compiles: connected/message/done protocol, ordered phases, exact step key/label taxonomy, and terminal state.
- Lint routes: orphan presence, dirty-topic count, and unmentioned-link presence.
- Cost routes: fixed-window user and vault aggregates across two users, two vaults, and three event types.

This is not the complete fixture matrix. Alongside successful R2 conversion, the following are explicit M4.3/M4.4-time additions: slug collision; zero-topics vault; empty vault; per-item failure isolation set; Absurd retry succeed-on-second; terminal-cancel 204; double `POST /compile`; zombie reconciler; SSE reconnect, heartbeat, and terminal variants; spoofed publish; embed-timeout-skip; and body-validation rejection.

`pnpm --filter @great-minds/goldens record:deferred` regenerates `goldens/python-deferred.json` only from the immutable cassette and stamps the coherent pair's `recordingId`. Check requires that provenance to match the cassette/golden pair. The command cannot contact OpenRouter and does not alter the banked cassette/golden pair.
