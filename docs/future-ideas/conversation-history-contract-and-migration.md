# Conversation history: Stage 2A contract and migration

> **Status: implementation specification draft for review.** Prepared at the user's request against `main` at `fe332ba`. This specifies the proposed next implementation; it does not describe deployed behavior, authorize a production cutover, or accept the wider future-ideas proposals. No application code or persisted data is changed by this document.
>
> Parent: [session publication/export staging proposal](./session-publication-and-export-rewrite-proposal.md). Companion: [acceptance-test matrix](./conversation-history-acceptance-matrix.md). The matrix distinguishes existing baseline tests from tests still to implement.

> **Authority clarified after implementation review.** The user prefers JSONL as the authoritative session-content store, the DB for other metadata/app state, and a possible derived Markdown presentation mirror. This supports continuing the history foundation, not moving canonical transcripts into the DB. Whole-application durability and interrupted-work recovery still require the DB and necessary checkpoint/files together; equivalent continuation after losing those stores is not a requirement. Preserve existing session display, visible tool activity, and normal follow-up context.

> **Implementation checkpoint:** The storage foundation and database-backed admission/settlement coordinators are now [connected to the native workflow and required consumers](../conversation-workflow-integration.md). Placement/default/revision are separate app state; acceptance freezes mode; preparation, stop/progress fencing, settlement, reconciliation, private history/Markdown, public selection, and browser hydration use the native contract. Controlled process tests include explicit provider/tool invocation ledgers. The bounded read-correctness pass adds same-attempt progress, separate operation readiness, receipt/access checks, unavailable child entries, and guarded browser merging. The former comprehensive `ConversationSnapshot` proposal is deliberately reduced as specified in §7; it is not another required framework. This is not a completed Stage 2 release: deterministic legacy-to-native conversion, backup/restore proof, and deployment rehearsal remain outstanding. See [storage](../conversation-history-storage.md), [admission](../conversation-reply-admission.md), [settlement](../conversation-reply-settlement.md), and the companion matrix. No production data has been converted, and the migrations must not deploy ahead of coordinated data/API/web/worker cutover.

## 1. Decisions this draft makes

1. Evolve the existing session JSONL into **one versioned conversation history**, not a second log alongside it.
2. Promise portable content and compatible-app conversation reconstruction. Full workspace restoration additionally needs app/control state; exact execution replay is not promised.
3. Preserve current BTW/standalone UX for the first implementation. Separate current placement, future response default, and historical reply provenance internally.
4. Put completed, stopped, and failed outcomes through one durable settlement path. A storage outage is pending finalization, not a newly invented generation failure.
5. Keep PostgreSQL, Effect, existing external-call ambiguity rules, and the current checkpoint substrate. Do not introduce a generic event-sourcing framework or an export/snapshot database.
6. Replace session/by-origin reads with one typed product projection. Keep execution-context reduction, public disclosure, and corpus promotion as distinct consumers.
7. Use a coordinated data/API/web cutover, with legacy decoders confined to offline migration/recovery tools. Keep meaningful IDs.
8. Keep the **current physical keys** `vaults/<vault_id>/sessions/<session_id>.jsonl` and `operations/replies/<reply_id>.json` within the vault owner namespace for this cut. `.gm/sessions` remains the portable/local-first layout direction, not a prerequisite for this work. Version the content, not the filename.

These are concrete implementation recommendations, not additional user-confirmed product policy. Publication defaults and exact-prompt retention remain separate decisions (§12).

## 2. Recovery contract and authority

| Fact | Authoritative home after cutover | Content-only recovery |
| --- | --- | --- |
| Question, answer, attempt order, completed/stopped/failed outcome | Conversation JSONL | Recoverable |
| Visible tool activity, selected citations/evidence references, and original quoted passage | Conversation JSONL | Recover recorded values; a reference is not a snapshot of its target |
| Retained model-facing messages and tool results used by normal follow-ups | Conversation JSONL | Preserve recorded context, without promising equivalent continuation after loss of app/control and execution state |
| Own reply chain and fixed inherited-context cutoff | Conversation JSONL, referencing other conversation IDs | Recoverable when dependencies are present; otherwise diagnose the missing dependency |
| Mode actually used, prepared prompt digest, known model provenance | Per-attempt record, copied from committed execution facts | Recover recorded values, not values inferred from today's defaults |
| Current inline/standalone placement and next-reply default | `sessions` app-state fields | Not promised; content import requires explicit defaults |
| Ownership grants, vault membership, share credentials | DB control plane | Not granted by a file's claimed author/owner |
| Accepted request/idempotency, active progress/cursor, cancellation, finalization payload | DB operation records plus checkpoints | Requires full operation-state recovery, not transcript import |
| Content indexes, transcript Markdown, terminal reply caches | Derived from history | Rebuildable within the selected recovery contract |
| Promotion into `raw/sessions/...` | Existing source/proposal authority and explicit promotion command | History alone does not make content part of the corpus |

One fact has one authority. Multiple stores are not themselves incoherent. A DB projection must identify the history revision it reflects; a DB-owned workspace choice must not be called a cache.

JSONL is authoritative for recorded session content, not a replacement for the application's complete durable state. Retain model/tool messages because normal follow-ups already use them, not to require JSONL-only restart or restoration. Backup and restore must cover the DB and necessary object/checkpoint files together. Markdown remains derived presentation and must not become a second independently editable history authority.

A standalone Markdown export preserves readable questions, answers, outcome labels, origins, and citations. It does not need internal tool traces or application placement to be useful in Obsidian. A JSONL import can recover more structure, but does not automatically resume unfinished operations, restore permissions, or replay generation.

## 3. Concrete history format

### 3.1 Encoding and identity

- UTF-8 JSONL with a final newline; one schema-valid record per nonempty line. The normal writer emits no blank lines.
- One header, first; subsequent records have contiguous positive `seq` values in physical order. Header is sequence 1.
- Header `format` is `great-minds/conversation`, `version` is `1`. Existing unversioned files are **legacy**, not version 1.
- `session_id` continues to use the existing path-safe `SessionId` decoder, not a new UUID-only requirement. Existing reply/exchange UUIDs remain unchanged.
- The natural identity of a record is `header(session_id)`, `attempt(reply_id)`, or `settlement(reply_id)`. No extra event-ID namespace is necessary.
- Record times describe the event, not a storage revision. Unknown legacy acceptance/settlement times are `null`; migration observation times go in the migration report instead of masquerading as original times.
- A file revision is `{ last_seq, sha256 }`, with SHA-256 over the exact complete file bytes. Backend ETags are opaque conditional-write tokens, not content hashes or portable revisions.
- Hashes are integrity/capture identifiers, not signatures, authorization, vault heads, or proof of an atomic DB/object-store snapshot. A standalone syntactically valid prefix cannot prove that no complete tail records were lost; live reads and writes also check the known session history receipt. Store that receipt once as session sequence/hash columns, not duplicate JSONB receipts on replies and sessions. Complete-archive recovery needs an inventory, not just independent file self-hashes.

### 3.2 Record shapes

The following is a logical encoded TypeScript contract to implement with Effect Schema. `SessionId`, `Uuid`, `SessionOrigin`, `ThinkingSource`, and `LlmMessage` refer to existing concepts; timestamps here are ISO strings, not in-memory `Date` objects. Runtime decoders must enforce the semantic rules below, not just the shape.

```ts
type Time = string; // ISO UTC timestamp, decoded at the boundary

type ReplyRef = { session_id: SessionId; reply_id: Uuid };

type Header = {
  type: "conversation";
  format: "great-minds/conversation";
  version: 1;
  seq: 1;
  session_id: SessionId;
  created_at: Time;
  author_id: Uuid; // attribution only, never an access grant
  origin: SessionOrigin | null;
  anchor_reply_id: Uuid | null;
  // Frozen inherited-context cutoff; not necessarily the annotated answer.
  context: ReplyRef | null;
};

type Attempt = {
  type: "attempt";
  seq: number;
  reply_id: Uuid;
  exchange_id: Uuid;
  // Preceding attempt of this same exchange, not the LLM-context parent.
  previous_attempt_id: Uuid | null;
  // Parent in this conversation's own context chain; inherited root is header.context.
  parent_reply_id: Uuid | null;
  question: string;
  accepted_at: Time | null;
};

type GenerationMetadata = {
  mode: "btw" | "query";
  system_prompt_hash: { scheme: "gm-prompt-v1"; value: string };
  requested_model: string;
  last_model?: string;
};

type Outcome =
  | { status: "completed" }
  | { status: "stopped" }
  | {
      status: "failed";
      code: "generation_failed" | "external_outcome_unknown" | "recovery_interrupted";
      message: string; // safe user-facing diagnostic, not an exception/secret dump
    };

type Settlement = {
  type: "settlement";
  seq: number;
  reply_id: Uuid;
  settled_at: Time | null;
  outcome: Outcome;
  answer: string;
  sources: readonly ThinkingSource[]; // no pending/provisional evidence
  context_messages: readonly LlmMessage[] | null;
  generation: GenerationMetadata | null;
};

type HistoryRecord = Header | Attempt | Settlement;
```

**Implementation simplification following user review:** do not introduce a generic known/unknown-fact representation or repeatedly decode internal typed values. Parse stored bytes at the read boundary; reducers and writers take concrete types. Readonly types and owned input data are sufficient here; no generic recursive runtime freezing is needed.

Absence has a concrete meaning for each field:

- `origin`, `context`, and the two attempt-parent fields are null when the relationship does not exist.
- `anchor_reply_id` is the actual annotated answer attempt when recorded; null means no recorded attempt ID. The origin already tells whether this is an answer annotation, so a second unknown-fact tag is unnecessary.
- Null acceptance/settlement times mean the historical time was not recorded; migration must not invent it.
- Null `context_messages` means the execution messages are not recorded. An empty array is a recorded empty context, not missing data.
- Null `generation` means no complete generation-metadata record is available. An omitted `last_model` makes no claim about whether a provider call happened. When present, it is the last model selection retained in committed evidence, not proof of the serving provider or a full fallback audit.

A newly completed native attempt must supply preparation metadata and context messages through the finalizer's prepared execution input. The stored format permits absence for imports and interrupted work, but normal execution must not turn known facts into optional bookkeeping. Detailed reasons for missing legacy facts belong in the migration report; invocation ambiguity and proof that no call occurred belong in durable operation state, not a generic history-field wrapper. Partial legacy provenance that cannot form `GenerationMetadata` remains in the migration evidence report rather than being expanded into a matrix of optional native fields.

Do not copy `kind`, current placement, current response default, DB progress versions, workflow cursors, JWTs, or share tokens into this format. Do not store the current title of a referenced source as though it were captured at answer time. Preserve selected source values already committed with the answer.

### 3.3 Reduction and validation rules

1. **Turn order:** first appearance of each `exchange_id` in an attempt record. Settlement timing does not reorder turns.
2. **Attempt order:** acceptance sequence within the exchange. The last accepted attempt is the selected attempt, even if it is running/failed. A late terminal record for an earlier attempt cannot select it again.
3. **Settlement:** at most one distinct settlement per reply ID. Identical command replay is a writer no-op; different content/outcome for the same natural identity is a conflict requiring investigation, never last-write-wins.
4. **Identity:** a reply ID belongs to one conversation/exchange. A retry is a new reply ID for the same exchange, preserving its original context parent. `previous_attempt_id` identifies the preceding accepted attempt; it does not assert that a legacy retry API was used.
5. **Parents:** intra-conversation parents must exist, precede their child, and terminate at `null`. Inherited context must be acyclic and within the authorized scope. Missing external history can leave content readable while continuation is unavailable; cycles are integrity failures.
6. **Question changes:** native retry keeps the original question. Legacy attempts with differing questions must be preserved and reported, not silently collapsed into one invented question. The selected attempt supplies the displayed question.
7. **Context:** completed/stopped replies can provide context under the existing rules. Failed attempts remain visible history but are not automatically admitted as usable LLM context. A new exchange skips them; retry preserves the failed attempt's original parent.
8. **Sources:** retain committed selected references. Filter `pending: true` from live observations before settlement; do not promote an unexecuted tool intent into citation evidence.
9. **Parsing:** unsupported version, unknown record type, invalid record, missing sequence, malformed line, or torn final line is an explicit integrity error. Normal reads do not skip, truncate, repair, or silently select a newer header suffix.
10. **Dependencies:** answer anchor and inherited-context cutoff are separate. A thread may annotate an older answer but inherit a later settled parent, as current behavior allows. Preserve both; do not equate the quote, exchange ID, and context cutoff.

Safe salvage belongs to offline tooling that retains originals, records the exception, and produces a separately reviewed result. An incomplete recovered prefix is not a successful complete export.

### 3.4 Example lifecycle

Abbreviated semantic sequence, not a literal JSON fixture:

```text
1 conversation C, origin = selected passage, context = parent P at reply p2
2 attempt r1, exchange e1, parent = null, previous_attempt = null
3 settlement r1, completed, generation.mode = btw
4 attempt r2, exchange e2, parent = r1, previous_attempt = null
5 settlement r2, failed, partial answer, generation.mode = btw
6 attempt r3, exchange e2, parent = r1, previous_attempt = r2
7 settlement r3, completed, generation.mode = btw

[Continue command changes app state; history is unchanged]

8 attempt r4, exchange e3, parent = r3, previous_attempt = null
9 settlement r4, completed, generation.mode = query
```

The projector retains all four attempts, selects r3 for e2, and does not reinterpret r1/r2/r3 when current defaults change. Default publication selects one attempt per exchange; an all-attempts appendix would be an explicit future option.

## 4. App state and prompting

### 4.1 App-state fields

Replace the overloaded persisted conversation `kind` with these logical fields in the existing session registry/control record:

```ts
type ConversationAppState = {
  placement: "inline" | "standalone";
  reply_mode: "btw" | "query";
  revision: number;
};
```

- Existing `btw` migrates to `inline` / `btw`; existing `session` migrates to `standalone` / `query`.
- `placement` controls main-list inclusion, route redirect, inline versus continuation-link rendering, and the current restriction against nesting an annotation beneath an inline BTW.
- `reply_mode` controls the next accepted reply's effective default. It is not used to label past attempts.
- `continueAsSession` remains the same owner-authorized, idempotent action and keeps the session ID and origin. One DB transaction changes both fields to `standalone` / `query` and increments `revision` once when anything changes.
- The current UI need not expose all placement/mode combinations. Separating fields separates their meaning; it does not introduce a settings UI.
- Content-title/origin indexes are derived from the header/first question. A listing may combine these projections with app-owned placement and last app interaction time. Rebuilding content indexes must not overwrite app state.
- A content-only import gets an explicit import policy for placement/defaults and ownership. It must not infer the user's last workspace from old answer length, prompts, or quote text. Implementing that import UX is not part of this cutover.

### 4.2 Policy capture boundary

**Freeze effective reply mode at durable request acceptance.** Read/update acceptance and the continue command under the same session-row lock/transaction, so their ordering is defined. A continued conversation can contain older accepted BTW-mode work; continue affects only subsequently accepted replies.

Prompt text/config/model resolution still occurs during preparation, as today. Persist the actual prepared mode, assembled prompt digest, and resolved requested model with the existing checkpoint **before any external request**. A prepared attempt never reloads a different prompt after restart. A deliberate user retry is a new attempt and may use the current default/config; it must not overwrite the old attempt's provenance.

`CreateReplyRequest.mode` currently exists but `prepareStep` replaces it with mode inferred from the session row. Remove that misleading mode input in the coordinated contract update; derive effective mode once from app state. The new-session `conversation_kind` input can remain a command choice for existing UX, mapped to initial app state, rather than becoming a historical file type. Do not reinterpret the separate `session.kind: new | existing` routing discriminant.

Minimal provenance deliberately does **not** archive the full prompt or all provider attempts. `system_prompt_hash` identifies the prepared system text only; it does not identify retrieved context, source versions, tool definitions, or all runtime inputs. Scheme `gm-prompt-v1` is the existing `crypto.ts` `promptContentHash`: SHA-256 over the UTF-8 strings `"prompt"` and the prepared text, each preceded by its four-byte little-endian byte length. It is **not** raw SHA-256 of the prompt text and must not be relabelled as such during migration. The body may be available in the current DB prompt registry, but a portable file must not promise that lookup will exist. Exact-prompt retention/export is a separate privacy/storage decision.

Legacy values are populated only from verified, reply-associated committed evidence. A request's `mode` is not sufficient evidence of the effective mode because current code overrides it. Current `sessions.kind` and current `prompts/query_btw.md` are not historical evidence. A terminal row's final `updated_at` is not automatically an exact settlement timestamp. A missing checkpoint or absent generation metadata does not prove that preparation or a provider call never happened: an outstanding external claim can mean the evidence was lost. Only positive operation evidence can establish that no call occurred, and missing history metadata must never authorize an automatic repeat.

### 4.3 Preserve context behavior

Keep execution context reduction separate from UI/publication projection:

- Follow own `parent_reply_id` links plus header `context` cutoff.
- Preserve the selected passage composition for the first anchored question.
- Preserve the previous usable turn's tool results and the current stubbing of older tool results.
- Do not inject historical system-prompt records as fresh live instructions on continuation.
- Do not silently substitute today's parent answer when an exact recorded parent attempt is missing.
- Missing context messages may block continuation or require an explicit future content-only fork; they must not erase readable conversation content.

## 5. Acceptance and settlement protocol

### 5.1 Acceptance durability

Keep request IDs/idempotency and dispatch in the existing DB control plane. Strengthen the handoff rather than introducing a second queue.

**Concurrency decision:** enforce the current UI's one-live-reply-per-conversation discipline on the server: at most one admitted or awaiting-admission operation in `running`/`settling` per conversation. Use the session-row serialization boundary plus a matching DB uniqueness constraint, not a process-local flag. A second distinct live submission returns a busy `409`; identical idempotency replay is checked first and succeeds. Different conversations may run concurrently. This deliberately tightens previously under-specified API concurrency, rather than inventing automatic branching or admission-order guesses. Continue can still change future defaults under the same row lock without mutating accepted work.

1. In a DB transaction, check authorization/idempotency, resolve the session and effective mode, and freeze an **acceptance descriptor**: stable IDs, timestamps, header if new, attempt payload, and context cutoff. Serialize session commands under its row lock; handle first creation through the existing unique idempotency key. Choose context/previous-attempt references from validated committed history; if the captured own-history revision changes before committing the descriptor, reject/reprepare without dispatch rather than guess a parent. A parent's later continuation does not invalidate an already selected inherited cutoff.
2. Store the immutable descriptor with the reply operation. A conflicting payload for an existing reply ID is `409`, including a different owner/vault/session. Do not mutate history before this conflict check.
3. Commit header plus first attempt atomically for a new history, or the next attempt for an existing one, through the history writer (§6).
4. Mark history admission confirmed; only admitted attempts may dispatch generation. Return the normal accepted response after history admission. If storage fails, return a truthful retryable admission error while retaining the same durable request ID for reconciliation.
5. A replay/reconciler completes the same admission; it never mints another session/attempt. No model call runs to repair admission. Recovery may finish an already authorized accepted request after a response was lost; callers retry with the same identity, not a new one.

The acceptance descriptor is an active operation obligation, not a second transcript authority. It may be retained under operation policy, but the settled read model never arbitrates answer text between this descriptor and history.

### 5.2 One finalizer for all outcomes

Add an explicit **`settling` execution phase/status** to the operation contract. Unlike `unavailable`, this is real persisted execution state, so schema, claim guards, reconciler, stream, and frontend types must change deliberately together.

1. Under the reply-row lock, decide the terminal outcome and freeze a complete immutable settlement payload (including timestamp and content) in `replies` operation data. Set `settling`; generation/progress writes are now fenced out.
2. Stop requests recorded before that decision win according to the existing stop policy. A stop after the payload is frozen is a no-op, not permission to replace a completed payload with stopped content.
3. Use the final committed checkpoint for normal completion. For stops/failures, preserve the appropriate committed partial snapshot, settled sources, and any known context/provenance. Do not discard a visible committed partial merely because the full provider response was not checkpointed; do not combine unrelated cursors to invent one.
4. Commit the settlement once through the history writer. Compare an existing settlement by semantic payload, excluding the writer-assigned sequence. Same payload is success; different payload is a hard conflict. Replays reuse the frozen time/content.
5. In a DB transaction, update terminal display projections, store the history receipt, and finish operation bookkeeping. Emit terminal product status only for a committed history settlement.
6. Reconciliation covers **both unadmitted acceptance descriptors and `settling` records**, not just current undispatched running rows. A failed history write leaves `settling` with an actionable storage diagnostic. A failed projection update after a history write needs reconciliation, never a model/tool retry.

`markFailed`/`failRunningReply` must no longer bypass this path. In particular, finalization exceptions must not convert an already committed success into a DB-only failure.

Keep Effect workflow activities, existing model/tool claim checkpoints, and no-repeat ambiguity semantics. A durable pending settlement can be recovered even if a workflow activity has already finished or died. Retrying finalization is safe; retrying an externally ambiguous model/tool invocation is not.

### 5.3 Failure windows and expected recovery

| Interruption point | Durable fact | Recovery / what the user may see |
| --- | --- | --- |
| Before acceptance DB commit | No accepted operation | Same request can be submitted; no generation authorized |
| After acceptance, before history admission | Frozen acceptance descriptor | Complete admission under the same IDs; do not dispatch early |
| After attempt admitted, before dispatch bookkeeping | Attempt + accepted operation | Existing idempotent dispatch reconciliation |
| During external invocation without committed result | Claim/ambiguity marker | Existing fail/stop policy; never infer provider success or auto-repeat the call |
| Before settlement payload persisted | Existing checkpoint/live facts | Reconstruct finalization from committed facts under existing ambiguity policy |
| After payload persisted, before history write | `settling` + exact payload | Retry history publication only |
| History write succeeded but acknowledgment lost | History may contain settlement | Read by identity; equal payload confirms success, no duplicate event |
| After history commit, before DB terminal cache | Terminal content is authoritative in history | Show settled content; command readiness may still be finalizing; reconcile cache |
| After DB terminal cache, before Markdown rendering | History + terminal receipt | Render derived artifact again; never undo settlement |
| Conflicting settlement or unreadable history | Integrity exception | Block mutation/publication, retain evidence; no last-write-wins fallback |

No garbage collection of checkpoints, operation receipts, or old migration data is authorized by this protocol alone.

## 6. History writer and storage boundary

Current `ObjectStore.append` is insufficient for semantic idempotency: R2's conditional retry protects bytes from lost concurrent appends, but does not atomically check record identity or reject conflicting settlements. The local implementation uses direct `appendFile`/`writeFile` without an atomic replacement/flush contract.

Introduce a narrow history-storage capability, not a generic storage/plugin framework:

```text
readHistory(owner, sessionId)
  -> missing | { bytes, backendToken, revision }

compareAndSwapHistory(owner, sessionId, expectedTokenOrMissing, completeBytes)
  -> committed | conflict | storage-error/unknown-write-result
```

The pure history reducer validates additions, detects idempotent replay/conflict, and assigns sequences against the exact read version. The writer CASes the validated complete next object; it never appends prevalidated bytes onto a newly read different history without rechecking invariants.

- **R2:** expose the existing versioned read / `IfMatch` / `IfNoneMatch` primitives through this narrow capability. Preserve opaque ETags. A conditional conflict performs no overwrite. On unknown write result, read the natural record identity to confirm rather than blindly append again.
- **Local:** implement the same logical operation using one scoped writer owner, serialized filesystem operations, temp-file write, file flush, atomic rename, and directory flush on supported filesystems. The implementation uses an OS advisory lock on a stable `.conversation-history.lock` file, released automatically on descriptor closure or process death. A second owner is rejected; there is no age/PID-based takeover or manual stale-lock removal. All history writers must cooperate with this boundary. Linux process-crash tests now cover ownership and replacement; other platforms/shared filesystems and power-loss guarantees remain outside that evidence.
- Return conflicts to the durable admission/finalization operation, which can reconcile from a fresh version. Do not add an unbounded inline retry loop or invent a new arbitrary retry budget here.
- Readers see complete old or complete new objects. They do not modify torn/corrupt files to make them readable.
- Keep physical-durability claims backend-specific. Tests of process crashes or fake R2 CAS do not prove host-power-loss guarantees.

These primitives now serve native conversation writes through `HistoryStore`; unrelated `ContentStorage` operations remain separate. They do not retroactively protect legacy writers. Cutover must replace/fence those writers without replacing every unrelated storage call in the project.

## 7. Shared read contract

### 7.1 Product shape

After the implementation review, keep the existing authorized `SessionsService` and pure history projector. Do not add a generic snapshot service or replace every consumer DTO. The implemented private response is:

```text
SessionContent
  events: opening metadata + selected exchange events
    reply_id, explicit content status, nullable observation version
    question, answer, visible thinking/sources, error, historical time
  activity: null | { reply_id, status: admitting | running | settling }

SessionResponse
  id, kind, origin_title, SessionContent
  threads: OriginSessionDetail[]

OriginSessionDetail
  available: session overview + SessionContent
  unavailable: session overview + detail
```

Content outcome and operation readiness are different facts. Recorded terminal text stays terminal even while `activity` says settling; the UI disables new work until the operation clears. Pending content uses the same attempt's committed DB progress and a within-attempt version. Missing content is not an empty answer, and an empty completed answer is not a running or failed reply.

Root corruption or inconsistent pending history is a read error. An authorized unreadable child keeps its identity/metadata and an unavailable explanation. Raw retained provider messages and generation internals are not exposed by this DTO.

The earlier schema-version/capture-time envelope, exported revision vectors, all-attempt API, queued-versus-generating substates, per-attempt provenance UI, and generalized dependency/anchor diagnostics are deferred. None is necessary merely to retain a saved answer, prevent duplicate generation after disconnection, or perform offline conversion.

### 7.2 Capture algorithm and honesty

1. Authorize the owned conversation and read its native history outside a database transaction.
2. Lock/recheck its owned session row, current receipt and app revision, then observe the live operation. No object-store I/O occurs under that transaction.
3. Project recorded content. Overlay progress only on the **same reply ID** without a settlement. If history is terminal but the operation is pending, preserve history and expose settling readiness.
4. Pending history without the matching live operation, or a receipt beyond the captured file's acknowledged prefix, is unavailable. A valid stored admission can supply a pending question in an existing readable history with `activity: admitting`; this does not assert that its attempt was recorded. An initial admission without acknowledged readable history still returns unavailable.
5. Read direct owned children through the same content boundary. Keep unreadable authorized children as unavailable entries. Before returning, recheck ownership and membership for all captured root/child IDs; access loss fails the response. By-origin loading uses the same child representation and final access check.
6. Return inconsistencies as retryable read errors; do not repair, generate, spin until idle, or silently salvage a corrupt prefix. Context construction separately follows the exact frozen parent chain and fails closed when necessary context is missing.

This is a bounded multi-part read, not a global atomic cut. Root/children may be observed at different times; the child set is selected once, and app/history revisions are not all rechecked after the final child. Complete child-set interval capture and a publication-specific immutable input envelope are deferred to an actual consumer that needs them. Ordinary reads do not claim those guarantees. Publication still must explicitly select and label content; an unreadable root cannot become a normal complete export.

### 7.3 Hydration and SSE

- Keep `events`, but require explicit selected reply identity/content status and a nullable DB observation version. Both session and BTW hydration use the same pure projection and stream merge.
- SSE reports operation status, including admitting and settling. It reads the DB projection, not history on every poll. Native settlement writes terminal DB state only after canonical publication; no terminal stream completion is emitted for admitting/settling.
- For one reply ID, hydrated terminal history dominates stream content even if the operation projection lags. Among pending observations, larger versions win; ignore nonincreasing versions and another reply's updates. No history sequence is presented as a comparable DB version.
- Connection failure is not reply failure. Retain partial text and the pending identity, offer reconnection to that operation, and require a recorded failed attempt for generation retry. A completed-empty answer receives its own label.
- Private reads and reply streams enforce ownership and membership. Reads recheck captured IDs; streams filter each row by owner and recheck membership before emission.
- Server command eligibility still uses operation state. A history-committed but unreconciled operation may display terminal content with follow-up/stop disabled. Browser phase is derived rather than independently mutated.
- Do not import `RepliesService` into its session dependency. The existing session service reads typed DB/history data; both services share the small pure operation mapper.

### 7.4 Disclosure and source promotion

Keep these explicit policies rather than exposing the private snapshot wholesale:

| Consumer | Stage 2 boundary |
| --- | --- |
| Private session/BTW reads | Own conversation plus authorized direct threads; explicit statuses/diagnostics; no raw provider/tool messages in the DTO |
| Existing session bearer share | Root's own selected exchanges under the existing disclosure scope; no newly attached threads, failed partials, model provenance, or inherited parent transcript |
| Existing reference share annotations | Respect `include_annotations` and existing owner/origin selection; do not add nested threads, failure partials, or private evidence because the reader can now see them |
| Promotion to corpus | Preserve current effective completed/stopped + nonempty-answer eligibility; failed/running/unavailable content is not made promotable by richer private reads |

Current session Markdown shares include source labels; do not accidentally broaden this to raw evidence/tool traces. To preserve preexisting failure disclosure, a selected failed attempt contributes at most the question/empty-answer representation the old reader provided, not newly portable partial text. Exact public rendering remains covered by disclosure regression tests. Once private Markdown can contain richer history, bearer shares must no longer serve that sidecar blindly: use an explicit share selection through the common serializer. Stage 2 may retain the existing serializer behind that selection until Stage 3 replaces it; do not build a permanent second Markdown renderer.

Promotion keeps deterministic source IDs/destinations and owner-versus-editor proposal behavior. Existing already-created source/proposal replay receipts remain valid. Publication and sharing are not mechanisms for minting access to private cited source documents.

## 8. Migration specification

### 8.1 Scope and inputs

A one-time offline converter reads an immutable inventory of:

- Session registry/app/control rows, reply rows (including requests/versions), and associated JSONL objects.
- Checkpoints needed to substantiate legacy outcomes/context/provenance.
- Share-subject IDs, source/proposal references, and relevant prompt-registry records when used as evidence.
- Object hashes/backend versions and DB export identifiers from the same final quiescent migration window.

A live dry-run is useful for estimates/exceptions but is not a consistent cutover backup. The final export occurs after writers are quiesced. Include all users' relevant conversation histories, not only visible standalone sessions. Protect the inventory/backups like production plaintext; reports need IDs/hashes/reasons, not copied answers, tokens, or prompts.

Retain old decoders as self-contained migration/recovery code. `migrate-session-replies.ts` and `recover-sessionless-replies.ts` now use the detached legacy schemas/projector, but neither is the native converter. Do not assume all production objects already match main's format merely because main only writes it.

### 8.2 Conversion rules

| Legacy input | Conversion / exception rule |
| --- | --- |
| Valid header, pending and terminal nodes for one reply | One header, one attempt, one settlement; preserve actual text/IDs/context/sources |
| Completed/stopped node without earlier pending node | Synthesize the structural attempt from that node with unknown acceptance time; preserve terminal time and annotate reconstruction in the report |
| DB failed row, matching pending node | Add failed settlement with committed partial/sources and safe error; provenance only from verified associated evidence |
| Terminal JSONL and stale running DB row | History owns settled content. Verify identity, preserve it, plan terminal-cache repair; no generation |
| Two differing terminal outcomes/payloads for one reply | Blocking conflict. Do not choose by timestamp, DB status, or latest line |
| DB completed/stopped row but no terminal JSONL | Recovery candidate, not automatic success. Require explicit verified reconstruction from committed evidence or leave a blocking exception; never claim exact LLM context if absent |
| Multiple attempts for one exchange | Preserve every reply ID; derive acceptance order from recorded log order and verified request relationships. Late settlements do not change the selected attempt |
| Identical duplicate record | Deduplicate after semantic comparison, record the input positions in the report |
| Current `sessions.kind` | Map to app placement/default only, not historical per-attempt mode |
| Checkpoint with verified reply/owner/context association | Use its committed preparation/provenance/context where consistent; record source hash in report. A filename alone is not sufficient identity proof |
| Request mode or today's prompt registry alone | Cannot prove old effective mode/prompt association; leave unknown |
| Pending orphan / still-active invocation | Classify for operator resolution. Do not fabricate completed/failed state or rerun calls. An explicitly approved interrupted settlement uses `recovery_interrupted` with migration-time provenance |
| Missing JSONL / dangling context / unsupported older format | Report and block automatic cutover of affected data until repaired or explicitly quarantined |
| Malformed line, repeated header suffix, unknown event | Preserve original bytes, flag exception; no copying current parser's silent skip/truncate behavior |
| Origin/metadata disagreement between DB and file | Field-level exception. DB-only placement is expected; conflicting content origin or author identity requires resolution |
| Missing historical prompt/context/source version | Retain unknown/unavailable; never backfill from current source text or today's config |

Historical replies with newer-schema impossible shapes are migration evidence, not a reason to add permissive normal-runtime decoders. Any ID remapping needed for genuinely older invalid IDs needs a deterministic saved mapping and complete reference migration; do not regenerate IDs afresh on every run.

### 8.3 Outputs and idempotency

Each dry-run produces:

- Staged new JSONL for each convertible conversation; deterministic ordering/encoding from fixed inputs.
- Proposed app-state and terminal-projection updates, with expected old values/versions.
- A migration manifest: tool/format version, source DB export identity, old/new object hashes, preserved/remapped IDs, reconstruction evidence, warnings, blocking exceptions, and verification results.
- A summary of exact question/answer/source-reference equality and the count/identity of attempts/outcomes/threads, not just aggregate row counts.

Repeated conversion of identical inputs yields identical history bytes. Applying an already-applied plan is a no-op only if current hashes/DB versions match its recorded new state. Changed inputs or conflicting destinations stop the run; they are not overwritten. Unknown acceptance/settlement timestamps stay unknown rather than using the converter's clock.

The manifest is migration/backup material, not a new runtime vault-head system. It does not become another authority for current conversation text.

### 8.4 Cutover runbook

1. **Rehearse** converter, projection rebuild, rollback, and fault tests against an isolated restored dataset. Inventory exceptions before scheduling downtime.
2. **Back up** DB and relevant objects, preserving exact legacy bytes and permissions/share records. Prove restoration in isolation. An object versioning setting alone is not a verified backup.
3. **Quiesce** API mutation admission, reply workers, and reconcilers that can touch these records. Drain safe running work or settle/cancel under existing ambiguity policy. No ambiguous call is repeated to make the migration cleaner. Residual activity blocks the cutover unless explicitly handled.
4. **Take the final inventory**, rerun conversion from that consistent source, and verify the source hashes/DB versions have not moved. No unresolved blocking exceptions; any deliberate quarantine must be reviewed and visible, not silent data loss.
5. **Stage and verify** all target histories and app-state/DB migrations while writers/readers remain unavailable. Replace the existing keys with verified new bytes; journal per-object application so a failed migration can resume or restore the exact originals.
6. **Apply schema/projection updates** and rebuild content-derived indexes/terminal caches. Preserve control rows, app state, IDs, source identities, share subjects/tokens, and idempotency receipts.
7. **Deploy coordinated API/web/workers**, invalidate or reject stale clients, and ensure old workers cannot write the unversioned format. No mixed-version runtime or dual-write period is part of this plan.
8. **Verify** private reads, BTW continuation/prompting, by-origin notes, streams, public disclosure, and promotion before reopening writes. Compare the saved migration invariants; verify zero unplanned external calls.
9. **Reopen and observe** finalization backlog, integrity diagnostics, and projection freshness. Keep immutable migration backups until acceptance and retention review.

**Rollback boundary:** before reopening writes, restore old objects, DB backup/schema, and old app together. After new writes are admitted, simply deploying the old app is unsafe. Re-quiesce, preserve all new data, and use a separately verified reverse conversion or forward fix. Do not promise a lossless post-write rollback that has not been built and tested.

A production execution needs explicit operator approval and a dedicated environment. This document is not permission to run it.

## 9. Implementation slices and code ownership

| Slice | Work | Existing seams / proposed new boundary |
| --- | --- | --- |
| 2A (this deliverable) | Contract, migration decision table, test matrix | This document and its companion; no runtime changes |
| 2B.1 | Strict format parser/reducer, identity/conflict tests, history CAS capability | `packages/server/src/conversation-history/{schema,history,store}.ts`; `storage/{object-store,r2-object-store,local-conditional-object-store}.ts`; standalone conformance/process-crash suites |
| 2B.2 | App state/mode freeze, single-live-reply enforcement, acceptance descriptor, unified settlement/reconciler | `packages/database/src/schema.ts` + migration; `sessions.ts`, `replies.ts`, `query.ts`; keep Effect workflow engine |
| 2B.3 | Bounded authorized read, same-attempt progress, separate readiness and unavailable children | Existing `SessionsService`, pure presentation/operation mapper, domain schemas; no new snapshot framework |
| 2C.1 | Migrate all consumers and remove old interpretations | `web/src/lib/{api/sessions,api/replies,session-events,reply-turn,types,session.svelte,btw.svelte,doc-threads.svelte}` plus saved-session hooks, origin navigation and affected components |
| 2C.2 | Preserve share/promotion policies and historical tooling | `shares.ts`, `markdown.ts`, `ingest.ts`, session promotion; migration/recovery scripts |
| 2C.3 | Converter, rehearsal, coordinated deployment and data migration | New offline history migration script; integration/recovery tests; operator runbook above |
| 3 onward | Shared publication compiler, isolated typesetting, controlled PDF | Parent staging proposal; history correctness is necessary but not a PDF implementation |

Use Effect schemas in the existing domain/server organization; do not introduce another type/validation system. Separate small pure record/projector modules from authorized I/O and orchestration. Exact module filenames can follow implementation cohesion; do not create empty service layers just to match this table.

The boundary between 2B slices is a review/testing boundary, not a requirement to deploy half-compatible intermediate schemas. New frontend architecture work must follow the repository's Svelte layering conventions.

## 10. Code evidence and baseline anchors

These are repository observations at `fe332ba`, not production incidents:

- `packages/server/src/sessions.ts`: `ReplyNodeStatus`, `currentNodes`, `exchangeEventFromNode`, parser, `continueAsSession`, `readTranscript`, `completeReply`, and `promoteExchange` establish today's mixed status/metadata semantics.
- `packages/server/src/replies.ts`: `acceptReply` appends session data before inserting the reply; `prepareStep` overrides request mode; `finalizeStep` writes completed/stopped history but not ordinary failed history; `failRunningReply` can settle only DB state; `reconcileOnce` finds undispatched running rows only.
- `packages/server/src/query.ts`: `setupContext` prepares the system message/hash and `executeModelAttempt` tracks selected model; terminal history receives only messages after `turnStart` through `replies.ts`.
- `packages/server/src/storage/r2-object-store.ts`: internal versioned read and conditional put used by byte append; `local-object-store.ts`: direct file writes/appends.
- `packages/server/src/shares.ts`: root Markdown for session shares; selected query/answer pairs for personal reference annotations. Neither is a license to publish the richer private snapshot.
- `web/src/lib/components/home-container.svelte`, `btw-thread.svelte`, `doc-header.svelte`, and `web/src/lib/btw.svelte.ts`: current conversation kind affects routing, rendering, listing and continuation actions.
- `packages/server/test/query.integration.test.ts`: explicit tests for pending-on-failure, fixed inherited context, same-ID continuation and prompt change, previous-turn tool context, failed-parent skipping, and idempotent acceptance.
- `packages/server/test/read-endpoints.integration.test.ts`: explicit tests for owner scope, invalid-event skipping/truncation, and Markdown-sidecar authority. The latter two expectations must change.

## 11. Completion criteria

Stage 2 is ready to ship only when the retained safety and migration gates in the [acceptance matrix](./conversation-history-acceptance-matrix.md#9-release-gates-and-next-executable-slice) have evidence. Section 7 and the matrix explicitly reduce the former comprehensive snapshot scope; those deferred surfaces are not silently counted as passing. Required guarantees include:

- All three outcomes commit history before terminal publication; no failure bypass remains.
- Format and CAS tests cover duplicate/conflicting settlement, concurrent updates and unknown write acknowledgment.
- Read/hydration/SSE use one interpretation of attempt identity, ordering, status and integrity.
- Historical prompt provenance never changes with workspace defaults and is not invented for old data.
- A clean content reconstruction does not require old DB answer fields; app state is restored/tested separately.
- Migration parity and pre-write rollback are proven on isolated restored data; unsupported/corrupt histories are accounted for.
- Public shares and corpus promotion do not gain access to private failed partials or newly included threads.
- No stale worker/client can introduce the old format after cutover; no normal-runtime legacy fallback remains.

## 12. Deliberately deferred decisions

These do not block implementing the format/reducer and settlement tests:

- Exact system-prompt/tool/input archival and retention versus lightweight historical identity only.
- Content-only import UI and its explicit default placement/mode choices.
- Whether to later simplify “Continue as a session” to “Open conversation” and alter current prompt/listing/nesting behavior.
- Default inclusion of continued BTW content, partial-export policy, evidence appendix, endnotes versus page-bottom footnotes, supported paper sizes/accessibility, and PDF renderer deployment.
- Checkpoint/operation GC, `.gm/` physical relocation, vault manifests, local-first packaging, encrypted sync, or any Effect/pi runtime change.
