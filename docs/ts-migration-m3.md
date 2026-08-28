# M3 — Write paths and the query engine

> **Completed-plan note.** Session creation, follow-ups, and BTW persistence now belong to durable replies. The temporary direct session-write endpoints carried through the port were retired after cutover; session reads, export, promotion, and sharing remain.

**Parent plan:** `docs/ts-migration.md`. **House rules:** `docs/ts-migration-m1.md` (Design stance, House rules — unchanged and binding). **Verification:** integration tests per task + `packages/parity` manifest extensions; LLM-dependent endpoints are excluded from parity with reasons and verified by stub-layer integration tests instead.

**Objective:** the TS backend serves every remaining non-pipeline endpoint — vault/member/config writes, proposals, source deletion, ingest surface, session writes, and the streaming query engine — leaving only the compile pipeline (M4) between this and cutover.

## Contract inventory extension (prerequisite)

`docs/api-contract-m3.md`, built the same way as the M1 inventory: enumerate every endpoint from `vault_routes.py` (writes), `proposal_routes.py`, `ingest_routes.py`, `query_routes.py`, `session_routes.py` (writes: btw, promote), and the doc-suggestion routes, cross-checked against the frontend consumers (`web/src/api/{vaults,proposals,ingest,query,sessions,doc}.ts`). **The `/query/stream` SSE wire protocol gets its own section**: every event type the frontend parses (`web/src/hooks/use-session.ts` + `use-job-sse.ts` are the consumers), field shapes, ordering guarantees, termination semantics, error frames. Include contract oddities + fixture requirements sections as before. Human decisions on oddities before implementation of the affected endpoint.

## Task breakdown (sequenced Codex runs, review gate between each)

**M3.1 — Non-LLM writes.** Vault create (name + thematic_hint → storage config seed + R2 bucket provisioning per decision 7 — this task retires that deferral; local backend seeds config only), vault config update, member invite/role-change/remove/ownership-transfer, vault delete (rows + storage: this closes decision 7's deletion side), proposals list/approve/reject (approval writes staged source per Python semantics), source delete (owner: rows + storage + search_index + memberships of its ideas per Python) and editor deletion-request. Role guards exactly per inventory. Parity manifest extension for all of it (mutation-flow style, fresh state per backend). Integration tests per house standards.

**M3.2 — Ingest surface.** Staged-upload lifecycle (`/ingest/staged-files` begin → presigned PUT (R2) or local equivalent → `/process` enqueue), URL ingest, raw ingest, doc suggestions (all four `UserSuggestionIntent`s), client-hash dedupe checks, compile-intent enqueue (rows + Absurd `spawn` via its SQL functions — the worker stays Python and is out of scope; TS writes the same queue rows Python would). Conversion (markitdown etc.) is worker-side → M4, not here. Parity extension where deterministic; exclusions listed with reasons where not (e.g. presigned URL contents — assert shape, not signature).

**M3.3 — Query engine + session writes.** The big one:
- **Querier**: agentic tool loop over `effect/unstable/ai` + `@effect/ai-openrouter` — tools `list_articles`, `search_content`, `search_in_document`, `read_document`, `expand_context`, `linked_articles`, `query_documents`, and vault-gated `web_search` (Parallel API + facts-only extraction). Retrieval behavior per the Python prompts and the inventory's protocol section; outline-instead-of-full-text for large docs; citation format rules. Design the TS service on its own terms (Python's 1,300-line module is requirements-reference only — decompose properly: tool registry, retrieval services reusing M1's read services, loop driver, stream encoder).
- **Prompts**: TS ships its own copies of `src/great_minds/core/default_prompts/*.md` (vault-storage override → packaged default resolution, like Python). A CI test asserts byte-equality between the TS copies and the Python package's files until cutover (drift guard; zero Python changes).
- **Streaming**: `/query/stream` on `HttpApiSchema.StreamSse` emitting the exact frontend protocol from the inventory. Client disconnect interrupts the loop (spike-proven pattern).
- **Session writes**: server-minted uuid7 session ids with client idempotency key, meta/exchange append + `.md` sidecar rebuild, BTW create/append (`query_btw` prompt variant, real multi-turn `HistoryMessage` history), promote-exchange (owner direct-ingest vs proposal branching).
- **Cost + telemetry**: per-call cost via the raw `GET /v1/generation` seam (spike round 2), recorded to `llm_cost_events` matching Python's row shape; wide-event structured logs for the loop (event names per repo convention).
- **Model config**: `QUERY_MODEL` (+ fallback-on-429 behavior per Python settings) through `Config`.
- **Verification**: integration tests with a **stubbed LanguageModel layer** (scripted tool-calls + token stream) covering: full loop with ≥2 tool rounds, streaming event sequence exactly per protocol, session persistence + idempotent retry, BTW thread flow, promote both branches, web_search gate off/on (Parallel stubbed), cost row written. Plus ONE live smoke (real OpenRouter, cheap model, tiny budget) behind an env flag, not in CI. `/query/stream` and BTW go on the parity exclusion list with reasons; deterministic session-write side effects (rows, sidecar) get parity coverage via fixture flows where feasible.

**M3.4 — Closeout.** Parity full-green including new manifest; review-pass punch list; browser smoke extension (ask a question against the stubbed... no — live smoke with real model on scratch data: query from the UI, BTW, promote, then a fresh compile-less ingest of a text file through staging). Update `docs/ts-migration.md` M3 line.

## Rules (delta from M1)

- Zero changes to `src/great_minds/`, `web/src/`, DDL. Absurd's SQL schema is invoked, never modified.
- The SSE protocol is contract: byte-level event framing per the inventory; the React hooks are the acceptance oracle.
- LLM calls in tests: stub layers only; the live path is exercised once per task at most, behind an explicit env flag, cheap model, never in CI.
- Every new endpoint lands with either parity manifest coverage or a written exclusion reason in the manifest.
- New secrets (Parallel API key) follow the Config/Redacted pattern; web_search stays vault-config-gated exactly like Python (no UI work — that gap is a product decision for later, unchanged by the port).

## M3.4 closeout punch list (accumulated from reviews)

- Session create-replay with DB row but missing JSONL: TS silently recreates meta-less file (Python 500s) — die or record alongside D5
- Parity D3 rule: add backend-scoped `events.*.context` normalization + require empty generic diffs (currently only checks the BTW event)
- Tests: assert created `sessions` row fields + `updated_at` bump on append/BTW; add 401/403 matrix to append/BTW routes
- uuid7 intra-ms monotonicity documented as non-goal
- From M3.2: upload-route 400/422 alignment done; recheck any remaining parity masks for over-breadth
