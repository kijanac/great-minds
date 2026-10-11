# Conversation history: acceptance-test matrix

> **Status: test specification, not a passing test report for Stage 2.** This accompanies the [Stage 2A contract and migration draft](./conversation-history-contract-and-migration.md), based on `main` at `fe332ba`. The standalone history parser/planner and local/R2 storage foundation now have executable conformance and process-crash tests; see the Stage 2B.1 validation below and [storage implementation boundaries](../conversation-history-storage.md). The matrix records the original target cases, not a claim of complete coverage. Native workflow and bounded read/client correctness are implemented. Section 9 explicitly narrows or defers parts of the former comprehensive snapshot proposal rather than requiring all 75 original targets as implementation scope. Native migration and cutover evidence remain unfinished.

> **Stage 2B.2 integration checkpoint:** The [admission](../conversation-reply-admission.md) and [settlement](../conversation-reply-settlement.md) coordinators now serve the native workflow. The [integration guide](../conversation-workflow-integration.md) records mode freezing, finite reconciliation scans, producer fences, required reader/client changes, and controlled process recovery with invocation counts. Both coordinators share one scalar session receipt. The staged migrations still require coordinated data/API/web/worker cutover. The bounded read pass adds active progress, unavailable children, finalization readiness, and receipt/access race checks. It does not establish complete child-set capture, native conversion, or deployment fencing.

> **Authority clarified:** JSONL owns recorded session content; DB metadata/app state and execution checkpoints remain necessary for whole-application durability. A Markdown mirror is derived presentation. Continue canonical-history consistency/storage tests, but do not require equivalent continuation or interrupted-work recovery after losing the DB/checkpoints. Preserve display, visible tool activity, and normal follow-up context.

## 1. Test organization and rules

- Use the current Effect Schema, Vitest, scripted LLM/provider, fake R2, and isolated PostgreSQL integration facilities. Do not introduce a second test framework.
- Keep pure parsing/projection/migration fixture tests free of a live DB or provider. Use deterministic IDs/timestamps and preserve literal text, Unicode, and source-reference arrays in expectations.
- Test raw history decoding separately from private read projection, execution-context construction, public disclosure, and corpus promotion.
- Fault injection must observe storage/commit events, not rely on sleeps to land in a crash window. Assert model/tool invocation counts, history bytes/records, DB versions, and client-visible state.
- Use separate attempts in fixtures: exchange identity, reply identity, anchor identity, and stream version must not be conflated.
- Never run destructive integration/recovery suites against an arbitrary configured `DATABASE_URL`. Require a dedicated disposable database and temporary local/object-store namespace.
- Preserve production originals in migration rehearsal. No tool/model network access is needed or allowed to reconstruct missing history.

**Mapping notation:** `extend` names an existing suite to expand; `replace` identifies a current expectation that must intentionally change; `new` names a proposed suite (not a file already created by this documentation work).

Server paths below are relative to `packages/server/test/`; web paths are relative to `web/src/lib/`.

## 2. Format and projection gates

| ID | Setup / action | Required result | Test home |
| --- | --- | --- | --- |
| H01 | Header + attempt + completed settlement, including an empty completed answer | Strict decode succeeds; completion is explicit, never inferred as streaming from empty text | new `conversation-history.test.ts` |
| H02 | Stopped and failed settlements with partial text and selected references | Text/outcome retained exactly; only committed nonpending references survive | new `conversation-history.test.ts` |
| H03 | Failed r1 then retry r2 for the same exchange; a replay/late event arrives for r1 | Both attempts retained; latest acceptance selects r2; r1 cannot replace r2 | extend `sessions.test.ts` → new projector suite |
| H04 | Two exchanges settle out of order | Original acceptance-based turn order survives; no timestamp sort | new `conversation-history.test.ts` |
| H05 | Same reply ID is assigned to another exchange/conversation | Decode/write conflict, no merged or overwritten answer | new `conversation-history.test.ts` |
| H06 | Missing parent, parent cycle, inherited-context cycle, forward self-reference | Explicit integrity/dependency error; no unbounded traversal | new `conversation-history.test.ts` |
| H07 | Unknown format version/type, invalid source shape, malformed middle line, torn tail, sequence gap | Strict failure with location/reason; no skipped line or successful prefix | replace parser expectations in `read-endpoints.integration.test.ts` |
| H08 | A syntactically valid older prefix conflicts with a known DB history receipt | Live capture fails/reports inconsistency; a fresh content-only import makes no unprovable completeness claim | new `conversation-snapshot.test.ts` |
| H09 | Two answer annotations use identical quote text at different offsets/attempts | Stable thread IDs keep both; anchor and inherited-context cutoff remain distinct | extend web `anchor-marks.test.ts`, `btw.test.ts` |
| H10 | Annotated passage no longer exists in current prose | Thread remains discoverable with original passage and orphaned-anchor state | extend web `anchor-marks.test.ts`, new reader test |
| H11 | Non-UUID but valid historical SessionId; invalid path traversal ID | Valid ID preserved; path escape rejected at boundary | extend `sessions.test.ts`, `read-endpoints.integration.test.ts` |
| H12 | Nonempty failed partial next to a completed empty answer | Neither status nor promotion eligibility is inferred from text length alone | new `conversation-snapshot.test.ts` |

## 3. App state, preparation, and context gates

| ID | Setup / action | Required result | Test home |
| --- | --- | --- | --- |
| P01 | Continue an inline BTW twice | Same session/origin; one app-state transition/revision change; no history rewrite | extend `query.integration.test.ts`, `read-endpoints.integration.test.ts`, web `btw.test.ts` |
| P02 | Accept reply before continue; prepare it after continue | Accepted reply remains BTW-mode; subsequently accepted reply uses query-mode | new cases in `query.integration.test.ts` |
| P03 | Continue races with acceptance | DB serialization yields one of the defined orderings; no mixed placement/default write | new app-state integration case |
| P04 | Edit prompt override after preparation then restart | Prepared attempt uses its committed system message/digest; no prompt reload | extend `reply-workflow-resume.integration.test.ts` |
| P05 | Earlier BTW replies, later query reply, then change current default again | Historical provenance unchanged and shown per attempt, not from current kind | new `conversation-snapshot.test.ts` |
| P06 | Stop before preparation | Zero provider calls established by operation evidence; no fabricated generation metadata | extend `query.integration.test.ts` |
| P07 | Provider call claimed but response/checkpoint lost | Missing metadata is not treated as proof of no call; ambiguity failure/stop without automatic repeat | extend `reply-workflow-resume.integration.test.ts` |
| P08 | Retry failed attempt after default/config change | New reply ID with current accepted default and original context parent; old attempt untouched | extend `query.integration.test.ts` |
| P09 | Missing checkpoint; legacy request mode disagrees with current kind | Converter leaves unsupported provenance unknown; never guesses effective mode from either field | new `migrate-conversation-history.test.ts` |
| P10 | BTW inherits parent through p2 while later parent gets p3 | Child context remains cut at p2; p3 absent; own transcript excludes inherited parent content | extend `query.integration.test.ts`, `sessions.test.ts` |
| P11 | Follow-up after failed attempt; previous/older usable turns have tool results | Skip failed context; preserve prior usable turn verbatim and stub older tool results as today | extend `query.integration.test.ts` |
| P12 | Missing inherited history or retained context during conversation loading | Readable own content survives with diagnostics; follow-up does not silently use a newer parent or invent a transcript | new reader/context tests |
| P13 | Prepared prompt with non-ASCII text and a saved `systemPromptHash` | `gm-prompt-v1` matches existing length-prefixed `promptContentHash`; not raw text SHA-256; references still resolve when the registry is present | new provenance/migration unit test |

## 4. Acceptance, storage, and settlement gates

| ID | Setup / interruption | Required result | Test home |
| --- | --- | --- | --- |
| D01 | Same create/retry request delivered concurrently under same ID | One acceptance descriptor/history attempt; same receipt; one execution | extend `query.integration.test.ts` |
| D02 | Same reply ID with different body, owner, vault, or destination | `409`/non-disclosing auth error as appropriate before history mutation; no extra pending node | extend `query.integration.test.ts` |
| D03 | Two distinct live submissions to one conversation | Defined busy/conflict result for the second; no overlapping context-parent/selection race; separate conversations remain independent | new acceptance integration test |
| D04 | Crash after acceptance DB commit but before history admission | Same descriptor completes admission; no early model call, duplicate session, or new IDs | new `conversation-settlement.integration.test.ts` |
| D05 | New conversation first write fails between construction of header and attempt | Atomic object write leaves neither or both; no readable header-only native conversation | new history-store conformance tests |
| D06 | Competing CAS writes on same history revision | One wins; other returns conflict and must revalidate on fresh history; no lost records | extend `r2-object-store.test.ts`, new history-store suite |
| D07 | Same settlement delivered twice, including after acknowledgment loss | Exactly one settlement identity/content; frozen timestamp preserved | new history-store/settlement suites |
| D08 | Different settlement payload/outcome for same reply | Hard conflict; original remains; no last-write-wins or silent first-wins success | new history-store/settlement suites |
| D09 | Crash after freezing terminal payload but before history commit | Resume only finalization; same text/outcome/provenance; zero extra provider/tool calls | new `conversation-settlement.integration.test.ts` |
| D10 | History commit succeeds, DB projection update fails | Read uses terminal history; readiness remains finalizing until repair; no false failure or generation retry | new settlement/reader integration tests |
| D11 | Ordinary model failure, setup failure, or ambiguous external call | Failed outcome reaches canonical history through unified settlement; pending-only history is no longer acceptable | replace `query.integration.test.ts` pending-on-failure expectation |
| D12 | Stop races with terminal-payload freeze | Stop committed first wins; later stop cannot mutate frozen settlement; two deterministic cases | extend `query.integration.test.ts` |
| D13 | Progress flusher races after state becomes settling | Late progress write rejected/fenced; cannot overwrite settlement or reset version/status | new `conversation-settlement.integration.test.ts` |
| D14 | History storage unavailable repeatedly | Explicit finalizing/storage diagnostic; durable payload retained; no terminal SSE and no model retries | new settlement/stream tests |
| D15 | Workflow has finished/died while DB still has settling record | Reconciler completes publication without relying on workflow re-execution | new settlement/reconciler integration test |
| D16 | Markdown sidecar rendering fails after settlement | History/terminal outcome unchanged; derived rendering can retry independently | extend `query.integration.test.ts` |
| D17 | Local crash around temp write, flush, rename, directory flush | Complete old/new file under supported guarantees; ownership guard rejects a second writer; distinguish process-crash test from power-loss claims | new local history-store/process tests |
| D18 | Stale worker tries an unversioned write after migration | Deployment/write fencing prevents old writer; no new-format log polluted by legacy appends | migration rehearsal + write-boundary test |

## 5. Capture, hydration, disclosure, and promotion gates

| ID | Setup / action | Required result | Test home |
| --- | --- | --- | --- |
| R01 | Terminal history plus stale running DB row | Same settled answer/status in private GET and SSE; operation readiness may lag separately | new `conversation-snapshot.test.ts`, integration read test |
| R02 | Terminal DB cache without matching history | Explicit inconsistency; do not export a fabricated complete answer or downgrade to generic running | new reader test |
| R03 | Pending history with missing operation | `unavailable`, not empty-answer-as-streaming; no read-triggered execution/repair | new reader test |
| R04 | Child added/removed or placement changed during capture | Stable selected membership/app revision or explicit refresh conflict; never silently omit a selected thread | new capture integration test |
| R05 | Active progress changes during capture | Return immutable versioned observation without spinning until idle; timestamps do not claim atomic DB/R2 capture | new capture test |
| R06 | Root malformed; one authorized child missing/unreadable | Root errors; child identity stays represented with diagnostic; no healthy empty/root-complete fallback | replace/extend `read-endpoints.integration.test.ts` |
| R07 | Hydrate, then receive older same-attempt progress; old attempt has higher numeric version than new one | No state regression; identity/order precede cross-attempt version comparison | extend web `btw.test.ts`, new reply-state merge tests |
| R08 | Fetch private history, by-origin notes or reply stream as another member/nonmember | Consistent owner/membership boundary; no private snapshot/evidence leak | extend read/query integration suites |
| R09 | Richer private history includes failed partials, nested context, prompt provenance and child threads | Existing bearer session share remains root-scope; none of the newly available private material is exposed | extend `shares.integration.test.ts` |
| R10 | Personal-reference share with annotations enabled/disabled | Existing query/answer and origin selection preserved; disabled annotations empty; no newly exposed failure partials or internal traces | extend `shares.integration.test.ts` |
| R11 | Completed/stopped nonempty versus failed/running/unavailable selected attempt | Preserve existing effective promotion eligibility; explicit source/proposal command only; no auto-index/compile from private history | extend write/query integration tests |
| R12 | Existing promoted source/proposal replay and unchanged share subjects | Same deterministic source ID/path and subject IDs; no duplicate artifacts/permission widening | extend source/share integration tests |

## 6. Migration and reconstruction gates

| ID | Fixture / action | Required result | Test home |
| --- | --- | --- | --- |
| M01 | Convert same immutable inventory twice | Identical staged history bytes, ordering and preserved identities; no clock-generated replacement times | new `migrate-conversation-history.test.ts` |
| M02 | Completed/stopped legacy log, failed DB-only outcome, several retries | Literal questions/answers/source arrays preserved; attempts/outcomes accounted for individually | new migration fixture suite |
| M03 | Terminal node without pending record | Structural attempt reconstructed with unknown acceptance time; evidence recorded; no fake original timestamp | new migration fixture suite |
| M04 | DB/file disagreement, malformed log, repeated meta suffix, unknown old event | Blocking exception with input identity/hash; no implicit winner, skipping or truncation | new migration fixture suite |
| M05 | Dangling origin/parent, duplicate quotes, branch beyond original cutoff | Preserve original passage and relationships; detect ambiguous reconstruction; never substitute live prose | extend migration/recovery fixture suites |
| M06 | Legacy current kind and historical modes differ | App-state mapping preserves current UX; historical provenance only from independently verified evidence | new migration fixture suite |
| M07 | Source changes between plan and apply; destination already contains different new history | Stop without overwrite; unchanged or already-applied verified state is idempotent | new migration apply test |
| M08 | Crash halfway through installing objects/DB changes during maintenance | Journal resumes safely or restores exact old files/DB; no mixed-version traffic admitted | isolated rehearsal |
| M09 | Rebuild content views without old DB answer fields, retaining app/control DB | Recorded history reconstructs; workspace settings not overwritten; LLM-context missingness remains honest | new reconstruction integration test |
| M10 | Import only content without workspace/control backup | Explicit defaults and new authorization required; no implied access grant, active-operation resume, or full workspace recovery | contract test; actual import UI deferred |
| M11 | Pre-write rollback, then separate post-new-write rollback simulation | Pre-write restores both stores/app; old app redeploy alone is rejected after new-format writes | isolated rehearsal |
| M12 | Converter attempts provider/tool network access | Test fails immediately; migration never generates replacement content | migration harness boundary |

## 7. Publication regression corpus to bring into maintained tests

These cases came from temporary synthetic actual-component fixtures under `/tmp/gm-pdf-review/styled/`, not production conversations. The maintained fixture inputs should be synthetic source data, not dependencies on those temporary files or golden PDFs preserving current defects.

| ID | Fixture | Required future artifact assertions |
| --- | --- | --- |
| X01 | Long answer (95 numbered sections) | Every section, final conclusion, and citation body survives across pages |
| X02 | Several answers/BTWs reuse footnote numbers | Unique fragment targets in both Markdown and HTML; each actual PDF link goes to the intended definition |
| X03 | Same saved threads with open/closed UI, narrow viewport, docked panel | Same selected document content; no Reply/Send/Continue controls or unsent drafts |
| X04 | Wide table, long code line, long URL, multilingual text | No lost cells/characters; selected text and fonts correct on supported paper sizes |
| X05 | Running, finalizing, failed, stopped, and unavailable inputs | Truthful labels under the chosen partial-export policy; never an unlabelled completed-looking partial |
| X06 | Vault-relative and external citation links | Correct native destinations; no dependency on app click interception or automatic public-share minting |
| X07 | Inherited/continued/unresolvable threads | Inclusion follows the confirmed policy; no accidental recursive parent/sibling disclosure |
| X08 | Markdown and PDF from one immutable capture | Semantic selection parity; refreshing live session cannot mutate the prepared artifact |

These are Stage 3–6 artifact gates. Inclusion, partial-export policy, endnotes/footnotes, supported paper sizes, accessibility requirements and renderer deployment remain decisions to confirm. Do not block pure history-format tests on those choices.

## 8. Baseline validation performed for this draft

During the original Stage 2A documentation pass, no new application/schema implementation was added. The following commands exercised **existing main behavior**, not the proposed guarantees:

```sh
# From repo root; use the server config, including its integration-capable timeouts.
pnpm exec vitest run --config packages/server/vitest.config.ts \
  packages/server/test/sessions.test.ts \
  packages/server/test/migrate-session-replies.test.ts \
  packages/server/test/markdown.test.ts \
  packages/server/test/storage.test.ts \
  packages/server/test/r2-object-store.test.ts

# From web/
pnpm exec vitest run src/lib/btw.test.ts src/lib/anchor-marks.test.ts
```

Results for this drafting pass:

- Server: **5 files, 13 tests passed** with the server configuration.
- Web: **2 files, 24 tests passed**.
- Initial server invocation from root without `--config` hit Vitest's default 5-second timeout in the R2 append retry-budget case: 12 passed, 1 timed out. Rerun with the repository's existing server timeout configuration passed; no test or production timeout was changed.
- DB-backed integration, process-crash suites, migration rehearsal, new-contract tests, and new PDF artifact tests were **not run/implemented in this documentation step**. Existing integration sources were inspected to map their assertions. Production DB/bucket contents were not inspected.

Non-fatal toolchain warnings: pnpm ignores the workspace's old `confirmModulesPurge` setting; the web run reports Node's `module.register()` deprecation warning.

### Stage 2B.1 implementation validation

After implementing the history/storage foundation, the following combined run passed **10 files, 121 tests**: 108 tests in five new history/storage suites plus 13 existing regression tests.

```sh
pnpm exec vitest run --config packages/server/vitest.config.ts \
  packages/server/test/conversation-history.test.ts \
  packages/server/test/conditional-object-store.test.ts \
  packages/server/test/conversation-history-store.test.ts \
  packages/server/test/local-conditional-object-store.test.ts \
  packages/server/test/history-process-crash.test.ts \
  packages/server/test/sessions.test.ts \
  packages/server/test/migrate-session-replies.test.ts \
  packages/server/test/markdown.test.ts \
  packages/server/test/storage.test.ts \
  packages/server/test/r2-object-store.test.ts

pnpm run typecheck
```

The root type check passed for domain, database, server, goldens, and lint packages. Targeted `oxlint` over the changed/new history, storage, and test modules passed, as did `git diff --check`.

The new tests exercise the parser/planner and storage portions of the H/D gates, including conditional creation, competing writes, duplicate/conflicting settlement, acknowledgment loss, and local process death. The local tests use actual OS-owned locking and child-process `SIGKILL` at controlled rename boundaries, without manual lock removal. R2 tests use the real S3 SDK with a fake HTTP transport. They do not establish live R2 behavior, host-power-loss durability, DB-backed finalization, authorized reader consistency, or migration readiness. The 108 foundation tests are not 108 completed matrix gates.

No database or production storage was used. The earlier web baseline was not rerun in this storage-only pass. The new foundation remains separate from the live session/reply paths.

## 9. Release gates and next executable slice

This section supersedes the original blanket requirement to implement every H/P/D/R/M target before Stage 2. Keep the storage, identity, authorization, outcome, context, disclosure, conversion and rollback safety requirements. Use the bounded read contract in [§7](./conversation-history-contract-and-migration.md#7-shared-read-contract), not a new comprehensive snapshot framework. X cases still gate the later publication cutover. An inherited test only counts after its assertions have been reconciled with the implemented contract.

The [native workflow integration](../conversation-workflow-integration.md) now connects storage, acceptance-time mode, one-live-operation enforcement, terminal settlement, and independent reconciliation. The current component suites include 51 admission cases and 40 settlement/restoration cases. Native process tests cover six admission, ambiguity, frozen-publication, and workflow-complete recovery cases with model/tool ledgers. The integration guide distinguishes current verification from the historical component counts above.

Concrete new evidence includes concurrent idempotent Continue (P01), accept-before-continue/prepare-after-continue (P02), no generation before confirmation or after a pre-preparation stop (P06/D04), ambiguous provider recovery without another call (P07), retained branch/tool context (P10–P11), unified failed settlement (D11), frozen publication after workflow completion (D15), private ownership/revocation (R08), failed-partial sharing/promotion exclusion (parts of R09/R11), and explicit empty/failed/stopped hydration (H12). These are evidence mappings, not declarations that every broader gate is complete.

### Bounded read evidence and deliberate scope reduction

The follow-up pass verifies 291 server storage/workflow/API tests, 44 query tests (one live smoke skipped), and 47 web tests: **382 distinct passes across 23 files**, not additions to the earlier totals. The [integration guide](../conversation-workflow-integration.md#verified-bounded-read-checkpoint) gives the run boundaries. Read tests use storage callbacks to advance receipts or revoke access during I/O; client tests exercise identity/version fences and render the actual status component.

| Original targets | Implemented evidence or explicit remaining limit |
| --- | --- |
| H08, R02–R03 | Current receipt is checked against captured bytes; pending history without the matching live operation fails rather than inventing progress. Reads do not repair. |
| H12, R07 | Explicit terminal/empty outcomes; same-attempt version ordering; old-attempt exclusion; hydrated terminal content cannot be overwritten by a lagging stream. |
| R01, D10 | Private GET preserves recorded terminal content while activity remains settling; browser merging preserves it until terminal operation confirmation. **Reduced:** raw SSE remains a DB projection, not a canonical-history reader on every poll. |
| `R04` | Each content read checks current app revision; final access checks cover captured root/child IDs. **Deferred:** a complete child-set/app/history interval capture and exported revision vector. New children after enumeration are not part of that response. |
| `R05` | Same-attempt committed progress and DB observation version are returned without waiting for idle. **Deferred:** a general capture envelope/timestamp API. |
| R06, R08 | Unavailable authorized children retain identity without editable empty content; root errors remain errors; revocation/ownership races fail without disclosure. Initial admission with no acknowledged readable history still returns unavailable. |
| `D14` | Settling remains nonterminal, controls stay blocked, and durable/process tests prevent another model/tool call during publication recovery. **Deferred:** a separate storage-health diagnostic taxonomy in the UI. Connection loss is distinct and offers same-reply reconnect. |
| P05, P12 | Recorded metadata/context remain native content, and context construction fails closed. **Deferred:** per-attempt provenance/all-attempt UI and generalized missing-dependency/anchor diagnostics in ordinary reads. |

These are explicit reduced guarantees, not claims that the original stronger rows all pass. There is no new snapshot service, revision protocol, persistence table, or independently mutable queued/generating UI state in this pass.

Next implement a deterministic one-off offline converter, dry-run exception/content accounting, and an isolated backup/restore and stopped-writer cutover rehearsal. Do not introduce online dual-writing or a migration platform. D18 and the native M cases still need actual conversion/deployment evidence; P04 and any retained provenance guarantees still need their dedicated fixtures. Conversion must not guess missing provenance or repeat external calls. Once those safety requirements are established, return to the publication/PDF defects.

Before opening a production maintenance window, attach actual test/rehearsal evidence and a resolved migration exception report. A green unit-test baseline or this matrix alone is not migration approval.
