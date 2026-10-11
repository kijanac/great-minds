# Session publication and export rewrite: staging proposal

> **Status:** exploratory proposal for discussion, not an accepted architecture decision or implementation commitment. The findings below were inspected in repository code and synthetic component fixtures, not production sessions. No application implementation changes have been made.

## Goal and posture

The user explicitly prefers the highest-quality end result, including code quality and simplicity, even if that requires substantial churn. Replace the publication boundary rather than accumulating print-specific exceptions in interactive components. Minimize the number of concepts and authorities in the finished system, not the size of the diff.

This work should not depend on adopting a new agent runtime, moving the product to local-first, or implementing encrypted sync. A renderer can later run in the local runtime without changing the publication model.

## Findings motivating replacement

Current PDF export calls `window.print()` and prints `#session-print` from the interactive app. Actual compiled Svelte components, the application's stylesheet, and synthetic session state were tested in Chromium:

- A 95-section answer printed one page containing only three paragraph markers, without the conclusion or footnote definitions. A fixture-only ancestor-overflow override recovered 26 pages and all content. The current `.print-root` rule misses the outer `PanelHost` clipping ancestor.
- Collapsed BTW threads disappear. Open ones print reply/send/continue controls.
- Footnote definitions are restored by print CSS, but separately parsed answers and BTW bodies reuse fragment IDs. Distinct citations can have the same PDF destination.
- App-relative source links resolve to unintended session-relative URLs in the PDF.
- Wide table columns and the end of long code lines are lost horizontally.
- Running replies have no explicit incomplete-document label; stopped/failed messages do print.

There are also data-model issues relevant to staging:

- `SessionEvent` does not expose a complete reply status. The client infers streaming from an empty answer and a reply ID.
- Terminal completed/stopped nodes and active/failed reply snapshots are currently split across JSONL and DB records.
- `readSession` loads attached conversations separately as `threads`; current `renderSessionMarkdown` renders only the session's own exchanges. Older product documentation claiming all BTW text is included in Markdown is stale for this implementation.
- Session shares consume `readMarkdown`. Changing that projection can change what an existing bearer link discloses.
- The application root layout wraps public and authenticated pages in `AppShell`. Merely placing an export route outside `(app)` does not remove that shell.

## Proposed end-state architecture

```text
Canonical conversation history + app/control state + active-operation observations
    → readConversationSnapshot
    → immutable ConversationSnapshot
    → compilePublication(document, inclusion policy)
        ├─ Markdown serialization
        └─ dedicated HTML document / Svelte presentation
            ├─ isolated preview / print surface
            └─ controlled HTML-to-PDF renderer
```

The interactive session UI should also consume the canonical session read model, adapting it into its own live state. Publication must not depend on that mutable UI state.

Keep the boundaries small:

- Domain contract: immutable conversation structure, stable identities, explicit status, origin, citations, and capture provenance.
- Loader/projector: authorization, reading current durable facts, reconciling their documented precedence, and projecting the contract.
- Publication compiler: pure inclusion, Markdown AST transformations, citation/fragment identities, and link resolution.
- Presentational document: props in; no API calls, session methods, navigation interception, selection controls, or streaming subscriptions.
- PDF adapter: renders the same authored HTML and styles. It does not reconstruct conversation semantics.

Reuse standard Markdown AST/HAST tooling. Do not introduce a proprietary document AST, a second frontend framework, or a generic export-provider/plugin system for this feature.

## Proposed product contract — requires confirmation

- Export the root conversation and all directly attached BTW threads by default, independent of expansion state. Represent promoted/continued threads explicitly. Do not recursively pull in parent conversations, sibling sessions, or further linked sessions merely because there is a link.
- Preserve questions, answers, origin/passage context, and readable citation identification.
- Exclude unsent drafts, interactive controls, raw tool/model traces, and retrieval/search evidence by default. An evidence appendix can be an explicit option, with the same selection applied to PDF and Markdown.
- Running, stopped, failed, and unavailable content are explicit states, not inferred from empty text. A captured partial reply is conspicuously labelled incomplete.
- Export content is frozen when prepared. Later tokens, turns, or option changes do not silently mutate an already prepared artifact. Refresh/reprepare is explicit.
- A source link requiring Great Minds access is labelled accordingly. Use an original external URL when known and appropriate, without minting public shares or widening access automatically.
- Provenance describes the captured records honestly. A capture timestamp or payload hash is not proof of an atomic DB/R2 transaction or answer-time source version.
- Public shares retain an explicit, separate disclosure policy. Reusing the read model must not silently expose newly included BTW/evidence/origin content through existing links.

## Stage 1 — contract, design brief, and regression corpus

Agree on the above semantics before implementation. Design the artifact as a scholarly research document, not a printed chat interface: readable prose, clear question/answer sections, legible notes and citations, restrained metadata, and paper-appropriate use of the existing Libre Baskerville / JetBrains Mono pairing.

Bring the disposable review fixtures into a maintained test harness. Cover long text, many turns, collapsed/open notes, promoted/unresolvable anchors, repeated footnotes, internal/external links, code, tables, multilingual text, interrupted replies, missing data, narrow/desktop entry points, and A4/Letter output.

Record current defects as repros, not golden expectations to preserve.

**Gate:** explicit expected content and link destinations exist; inclusion decisions no longer depend on current screen disclosure state.

## Stage 2 — canonical conversation history, read model, and migration

**Revised recommendation:** the user explicitly allows breaking contracts and migrating data where that simplifies the finished system. Prefer a coherent conversation-history and API cutover over a read-only facade that permanently reconciles legacy formats. Include terminal-history hardening in Stage 2; it is a declared write-path/schema change, not a hidden DTO change.

**Stage 2A drafting deliverable:** [concrete history contract and migration specification](./conversation-history-contract-and-migration.md), with an [acceptance-test matrix](./conversation-history-acceptance-matrix.md), now defines the proposed record shapes, app-state/prompt boundary, conditional storage protocol, read semantics, conversion rules, and cutover gates against `main` at `fe332ba`. These are reviewable implementation recommendations, not implemented guarantees or production migration approval. That draft keeps current physical session keys for the first cut; `.gm/` relocation is separate.

### Authority boundary

- **Canonical conversation history:** versioned file-backed records containing conversation content metadata, origin/branch links, accepted turns/attempts, and every settled outcome: completed, stopped, or failed, including committed partial text and selected source references.
- **Active operations:** DB operation records plus checkpoints own request/idempotency, execution cursor, cancellation, in-flight snapshots, and pending finalization work.
- **Application/workspace state:** current placement, listing preferences, and future reply defaults may remain independently authoritative app state. If DB-owned, they need their own backup/sync policy and must not be called rebuildable content projections. Their exact ownership remains a design choice.
- **Projections:** content indexes, rendered Markdown, and terminal UI/SSE caches are derived from committed history; final listings/views may also apply authoritative workspace state. Control, app-state, and projection fields/tables should have explicit ownership rather than ambiguous duplicated truth.
- **Access control:** authentication, membership, ownership grants, and share credentials remain control-plane authority. An imported transcript cannot grant itself permission by asserting an owner field.
- **Publication:** `ConversationSnapshot` is an immutable derived view, not an additional canonical table/file or automatic source promotion.

### Recovery contract — proposed scope

Recommend content portability and conversation reconstruction, not a promise that one file can reproduce all application behavior:

1. **Portable content:** readable Markdown preserves questions/answers, outcome labels, and readable origins/citations without Great Minds. Referenced vault files/assets may still be dependencies. Obsidian need not understand hidden application metadata.
2. **Conversation reconstruction:** versioned history plus a compatible Great Minds app can recover recorded turns, attempts, outcomes, relationships, and selected provenance. Continuing uses deliberately selected/current policy, not an automatic promise to recreate every historical runtime setting.
3. **Full workspace restoration:** requires restoring durable app/control state as well. Workspace choices omitted from a content-only import must be explicitly reset/defaulted, not presented as recovered. That state can be backed up separately or included as hidden app metadata in a fuller archive.
4. **Execution provenance/replay:** a stronger, separate contract. Minimal per-attempt mode/model/prompt-version facts can explain past replies; exact prompt inspection requires retained prompt text or an available immutable reference, not a hash alone. Neither guarantees identical model output or authorizes rerunning ambiguous external calls.

Coherence is one authority per fact and honest publication, not everything being in one file. Historical reply policy, current conversation defaults, and current UI placement are distinct facts: changing the latter must not reclassify past attempts. Exact provenance capture/retention is still to be chosen, and migration must not invent absent historical values.

“History file” means an evolved/replacement version of the existing `sessions/<id>.jsonl`, not a second parallel conversation log. JSONL can remain the encoding. The important changes are complete terminal outcomes and selected content/provenance facts, explicit schema and integrity semantics, and the writer's settlement discipline—not a new filename or an automatic adoption of a durable-agent framework. Existing IDs, origins, source references, and LLM messages are useful content already present in the current log.

The recommended portable/local-first history namespace remains `.gm/sessions/...`, as in the sessions proposal; relocation is organizational, not what establishes authority or durability. The Stage 2A draft keeps the current physical `sessions/<id>.jsonl` key under the vault owner namespace and introduces one versioned format there. Keep legacy decoders in migration/recovery tooling, not the normal runtime. Preserve conversation, exchange, reply-attempt, source, and share-subject identities where they carry real meaning; breaking shapes does not require reminting those identities.

Persist minimal recorded content, origins, thread lineage, and useful provenance—not every legacy DB field. A `kind: session | btw` enum is not inherently required in canonical history: it may be derived from durable facts, remain app-state-owned, or disappear under a unified conversation model. Current `kind` conflates listing, route redirection, inline-versus-continued rendering, nested-BTW eligibility, and future reply prompting. Separate those meanings before choosing which facts belong to portable history versus full workspace restoration. Preserve the messages/context information currently required for LLM parent-chain semantics, but keep internal provider/tool material out of public payloads by explicit policy.

### Settlement before publication

Use one idempotent settlement path for completed, stopped, and failed outcomes:

1. Durably prepare the terminal payload in the operation ledger/checkpoint so finalization can be retried without repeating generation.
2. Commit the terminal history record using stable identity and serialized/conditional writes.
3. Update/reconcile DB projections and operation bookkeeping from that committed record.
4. Publish terminal product status only after the history commit exists.

An identical duplicate settlement is safe; conflicting terminal payloads for the same attempt must not silently overwrite one another. A crash after the history commit requires projection repair, not another model/tool call. A history-write failure leaves explicit pending-finalization/storage failure state, not a falsely complete artifact. This is ordered, recoverable cross-store publication—not a claim that Postgres and R2 have become one atomic transaction.

The simplified reader rule is: **committed terminal history owns settled content; operation snapshots supply progress only for attempts not yet settled in history.** Define execution-versus-history observations during finalization explicitly, so a stale running cache cannot overwrite settled content or misrepresent operation readiness.

### Read model and consumer cutover

Introduce `ConversationSnapshot` with explicit turn states and stable session/exchange/attempt/thread identities. Preserve direct-thread order and origins even when an anchor cannot be placed in current prose. `unavailable` and integrity diagnostics belong to the read model, not to the persisted generation status machine.

Keep the pure projector and narrow loader independent of orchestration to avoid a `SessionsService`/`RepliesService` dependency cycle. Hydration and SSE updates must respect attempt identity/version and terminal history. Readers never repair/rewrite history or trigger generation just to make an export appear complete.

Define capture consistency and record actual input versions/hashes where available. A timestamp or payload hash is not a vault commit/head or proof of an atomic DB/R2 revision. Surface corruption, missing records, and unsupported data instead of silently labelling a recovered prefix complete.

Replace the lossy session read contracts and migrate all their consumers in a coordinated API/web release: saved sessions, BTWs, document/reference notes, origin navigation, private publication, public-share adapters, source-promotion adapters, and affected recovery scripts/tests. Remove empty-answer-as-streaming inference and duplicate replay code. Preserve explicit source-promotion eligibility and public-share disclosure; a richer private snapshot must not widen existing links or make failed partials sources automatically.

Execution implementation can change where necessary for settlement, but preserve the product invariants: acceptance/idempotency, stop/retry semantics, parent-chain LLM context, and no automatic repetition of ambiguous model/tool calls. Do not couple the work to a new workflow engine, model routing, or checkpoint GC policy.

### One-time migration

1. Inventory and back up DB records, session objects, and relevant operation/checkpoint data. Inventory share subjects and promoted-source references too.
2. Dry-run conversion from legacy JSONL plus DB-only metadata/outcomes into the new canonical history format. Backfill failed outcomes from committed reply state with honest provenance; do not invent missing text, historical source versions, or provider outcomes.
3. Report malformed histories, dangling links, and disagreements as explicit exceptions. Do not silently skip them or choose a winner solely by timestamp.
4. Verify preserved IDs, literal questions/answers, outcome state, source references, anchors, branch/context relations, and authorization/disclosure boundaries. Prove settled content and explicitly selected provenance can be reconstructed from history without the old DB content fields. Verify retained app-state fields separately; this does not imply recovering all listing/placement/default choices, authentication, active operations, or share grants from transcript files.
5. Quiesce writers and handle active operations under the existing cancellation/ambiguity policy. Migration must not rerun external calls to fill gaps.
6. Stage and verify converted data, then coordinate writer/reader/API/web cutover and refresh stale clients. Normal runtime accepts only the new format.
7. Rebuild projections, verify parity and crash recovery, and retain old data as rollback/backup material until the migration is accepted. Later GC is a separate operation.

### Relationship to the other proposals

| Related proposal | What expanded Stage 2 advances | What remains outside it |
| --- | --- | --- |
| Sessions/conversations/vault content | Complete terminal history, necessary content metadata, and a shared read model; history stays separate from corpus | Session sharing/key policy and checkpoint retention decisions |
| DB/files Obsidian-like vault | Implements the conversation-content/projection boundary in one bounded domain | Source/wiki/config manifests, graph recovery, or replacing the DB control plane |
| File-backed vault migration | Pulls the conversation-history portion of Phase 6 forward with an explicit migration | The broader source/wiki head migration and automatic checkpoint/row GC |
| Durability lessons | Commit-before-terminal-publication and idempotent settlement/projection recovery | General invocation ledgers, DB/R2 atomic transactions, or changed storage durability guarantees |
| Agent runtime / pi-durable | Provides a stable product-history boundary for a future runtime adapter | Effect/pi migration or changed ambiguous-call replay semantics |
| Local-first and encrypted sync | Makes settled conversation content and metadata portable, with a shared hosted/local view | Substrate choice, encryption, epoch/grant policy, sync protocol, or permission widening |

Suggested implementation slices: **2A** defines format, authority, migration checks and read contract; **2B** implements unified settlement and projections; **2C** migrates readers/UI/share/promotion consumers and performs the verified data/API cutover. These are development/review slices, not a requirement to deploy incompatible intermediate states to production.

**Gate:** migration is loss-checked; settled history is file-recoverable; all three terminal outcomes use the same durable finalization discipline; hydration/SSE agree; fault-injection and projection-rebuild tests pass; no normal-runtime legacy compatibility path remains.

## Stage 3 — one publication compiler

Implement pure transformations from the document plus explicit inclusion policy. Parse prose using the shared Markdown pipeline; allocate identities and resolve links in one place.

Namespace footnote definitions and references in Markdown as well as HTML. Namespace headings/fragments too, and test repeated references within a turn and reused labels across main answers and notes. Preserve original stored prose; publication normalization is derived output.

Resolve internal citations into valid export links and readable source labels/paths. Distinguish answer-time provenance from metadata looked up at export time. Do not invent unavailable historical hashes or bibliographic information.

PDF and Markdown should represent the same selected conversation content and status. Their presentation may differ, but inclusion rules must not be independently implemented.

**Gate:** serializer fixtures and semantic parity tests pass; every included fragment reference has the intended unique target; native link behavior requires no app click handler.

## Stage 4 — dedicated document view and layout boundary

Create an export/preview route or document surface with no `AppShell`, `PanelHost`, viewport-height boxes, clipped scrollers, or interactive session components. Move shell ownership into the layouts that need it instead of adding an export exception to root-route conditionals.

Use thin route/composable wiring and a pure `SessionDocumentView` presentation. Share parsing and tokens with the reader, not the reader's interactive component tree.

Keep document CSS scoped. Design typography, title/provenance, question hierarchy, note sections, citation/endnote treatment, code wrapping, table fitting/repeated headers, long-link breaking, heading/page-break behavior, and appropriate page furniture. Do not avoid breaks around an entire long answer or thread; it must be able to span pages.

Use coherent endnotes/bibliography unless true page-bottom footnotes are an explicit requirement. Prove difficult typesetting features before selecting additional pagination machinery.

**Gate:** long-content and wide-content checks preserve all text and citations; light paper output is independent of app theme/viewport/panel state; manual visual review approves the document as a document.

## Stage 5 — controlled PDF generation and preparation UX

For the highest-quality final result, the recommendation is a real downloadable PDF produced by a pinned HTML-to-PDF renderer, initially Chromium if it meets the design contract. Keep the same authored HTML/CSS for preview and PDF, not a separate PDFKit or React renderer with duplicated layout semantics.

The adapter should be runnable privately on the existing infrastructure and later locally. Do not introduce a third-party PDF SaaS or require adopting the proposed local-first runtime first.

Bundle/pin assets and fonts, use explicit paper settings, wait for real asset/font readiness, and prevent uncontrolled network access. Invalid/missing assets or renderer failure must not silently produce a truncated or fallback-font document. Resource limits need measured/documented provenance; do not choose arbitrary document truncation limits or retry deadlines.

Verify selectable/searchable text, link annotations, font embedding, metadata, PDF reading order/tagging, and page numbering in the actual output. If Chromium cannot meet an agreed pagination requirement, choose one justified pagination engine rather than retaining competing layout implementations.

Expose preparing, ready, incomplete-warning, error, refresh, and cancelled states. Preview and download should refer to the same prepared snapshot; once generated, preview/download can reuse the same PDF bytes. Browser print can remain a secondary action from the isolated document, not an alternative live-app exporter. Never silently fall back from failed PDF generation to printing the app.

**Gate:** the supported browsers download the same prepared artifact through a truthful UI; artifact inspection, visual regressions, accessibility checks, and failure tests pass.

## Stage 6 — cutover and deletion

Wire the session export entry point to the new flow. Use the common projector/compiler for the Markdown API and, with an explicitly preserved disclosure policy, session-share rendering. Adapt the interactive session read path to explicit status/document semantics so it does not retain a parallel lossy projector.

Prefer one coordinated data/API/web cutover over long-lived compatibility adapters. Legacy format support belongs in one-time migration/recovery tools, not the normal runtime. Coordinate deployment and refresh stale browser clients; do not assume cached clients instantly update.

Delete the old live-DOM print entry point, `#session-print` isolation, `.print-root` escape rules, and redundant exporter-specific UI styling. Retire independent Markdown construction. Stop relying on `.md` sidecars as the authoritative API export input; retain any readable sidecars only as artifacts derived through the same serializer if their portability role is intentional. Physical cleanup of old artifacts is a separate task, not a prerequisite for safe cutover.

Audit all consumers before changing sidecar generation, especially public shares. Do not accidentally broaden existing bearer-link content.

**Gate:** one semantic projection, one inclusion/compiler path, one authored HTML document, and one PDF-generation backend remain; old reproduction cases pass on the supported entry point.

## What not to do

- Patch `body *` overflow, auto-expand notes on `beforeprint`, or hide ever more controls as the permanent architecture.
- Generate PDF from the existing `.md` sidecar and assume the data gaps are solved.
- Reuse `Session`, `AnswerBlock`, or `BtwThread` as publication components with many print/read-only flags.
- Maintain two independent citation normalization schemes or Markdown/PDF inclusion policies.
- Add an export jobs database, persistent snapshot store, render cache, or format plugin framework without a demonstrated product requirement.
- Couple this project to an Effect/pi migration, manifest-backed vault migration, or encrypted sharing rollout.

## Confirmation needed before build

1. Approve the proposed inclusion policy, including directly attached promoted BTW sessions and opt-in evidence.
2. Decide whether labelled partial captures remain exportable or the primary export action should wait for settled content.
3. Confirm a true downloadable PDF is the primary artifact, with browser print secondary.
4. Confirm whether endnotes/bibliography satisfy the print design or true page-bottom footnotes are required.
5. Establish supported output sizes, accessibility expectations, and where the renderer runs in the current deployment.
