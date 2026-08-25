# Goal: complete the Great Minds core research product description

You are working in the `great-minds-product-description` repository. Read `README.md`, `glossary.md`, `foundations/research-session-model.md`, and `reading-room/open-an-external-article.md` first. The README defines the purpose, scope, document template, method, structure, and coverage table. The other files become the vocabulary, foundation, and pilot exemplars: match their depth, tone, and structure exactly. Write every document in the README structure until the coverage table has no `not started` rows, then run the consistency, verification-checklist, and triage passes.

## Source of truth

Great Minds is checked out at `/Users/kijana/Documents/Code/great_minds`. Describe the authenticated desktop owner experience around one existing active vault, beginning at `web/src/routes/(app)/+page.svelte`, in the default configuration. Account setup, vault administration, non-owner journeys, the public share-recipient page, and device-specific mobile verification are out of scope as stated in the README.

Pin every feature document to source commit `c8c9e57` unless the user explicitly approves moving the whole description to a newer source commit. Do not silently mix source commits.

For each document, read in this order before writing:

1. Interaction state in `web/src/lib/session.svelte.ts`, the relevant `web/src/lib/hooks`, and the route and component that own the feature.
2. The matching browser request or stream in `web/src/lib/api` and the relevant service, workflow, or route implementation in `packages/server/src`.
3. Tests in `packages/server/test`. Start with `write-endpoints.integration.test.ts`, `read-endpoints.integration.test.ts`, `query.integration.test.ts`, `jobs-http.integration.test.ts`, `sessions.test.ts`, `shares.integration.test.ts`, and the workflow-resume tests; follow fixtures and focused unit tests where they define an edge case.
4. Shared product shapes and limits in `packages/domain/src/index.ts`, then durable relationships in `packages/database/src/schema.ts` when persistence changes what the user observes.
5. Visible behavior in `web/src/lib/components`, including loading, empty, error, narrow-viewport, disabled, popover, dialog, and panel states.
6. Runtime defaults in `packages/server/src/config.ts`, `justfile`, `web/vite.config.ts`, and feature constants.

Do not describe code. Describe what the user sees and does. Technical detail goes only in `> Technical note:` block quotes and only when the mechanism changes what the user would expect.

## Writing rules

- Follow the eight-section template in the README for every feature document. Foundations and cross-cutting documents may drop a phase that truly does not apply, but must cover cancel and interrupt behavior wherever an interaction exists.
- The five task phases are **arrive**, **leave without acting**, **begin**, **while in progress**, and **finish**. Use those exact subsection headings in that order.
- Context/state variants and cancel/interrupt behavior go in tables with columns **At arrival / Changed while active** and **Before work begins / While work is in progress**. Use the exact rows and order from the README. Fill every cell, including `No effect.` where appropriate.
- Interactions with other systems use the ten bold-led concerns from the README in their fixed order. Include one sentence even when a concern has no interaction.
- Use the glossary's words. If a needed term is absent, add one complete definition in the right glossary section before using it. Do not coin a synonym.
- Use sentence case for headings. Write directly and concretely, with no hedging or marketing.
- State surprising behavior plainly and explain it if the source or a comment gives a reason. If it looks like a defect, state that in “Open questions and verification” instead of smoothing it over.
- Cross-reference rather than repeat. Foundations own access, object identity, persistence, routes, recovery, and progress semantics. Feature documents link to those rules.
- Every interaction gets one Mermaid `stateDiagram-v2`, limited to states the user passes through. Omit internal bookkeeping states.
- Every feature document ends with `## Open questions and verification`, a bullet list, and `Verified against Great Minds commit \`c8c9e57\`.`

## Things already established (do not re-derive, do not contradict)

- The description's surface is one signed-in owner in one existing active vault on the desktop web app. Other roles are variants only where the owner-facing code branches on them.
- The unit of interaction is a task. Its phases are arrive, leave without acting, begin, while in progress, and finish.
- The context/state variant rows, interrupt rows, and cross-cutting concern order are fixed in `README.md`; changing them requires revisiting every drafted document.
- The product's UI word is *vault*. Do not substitute workspace, collection, project, corpus, or knowledge base except when quoting visible copy that still uses another word.
- Model prose is nondeterministic. Specify observable structure, state, evidence, persistence, and failure behavior, never exact generated wording.
- Personal references are account-scoped, not vault content. Creating one does not add vault search rows or queue a compile; exact normalized URLs reuse the existing reference without refetching.
- External-reference fetch accepts HTML and plain text, follows public redirects, times out after 30 seconds, and caps the response body at 25 MiB.
- Access and refresh tokens plus the active-vault identifier live in browser storage. One serialized refresh is attempted on 401, then the original request is retried once; refresh failure clears all three values.
- The active vault is not part of the route. The same vault-scoped URL is interpreted using the currently stored identifier, and browser Back does not restore an earlier vault.
- Vault selection is optimistic local state: it is stored before the destination proves loadable. There is no universal fallback or rollback for a deleted, inaccessible, or stale active vault.
- Server access levels are member (read), editor-or-owner (contribution paths), and owner (direct administration and destructive source work); a hidden control is never the security boundary.
- Vault sources use nested `raw/…/*.md` paths, vault articles use `wiki/*.md`, and personal references use account-scoped `refs/*.md`; `/doc/` resolves inside the active vault while `/refs/` resolves inside the account.
- Saved, indexed, and compiled are distinct boundaries. A source can be durable and searchable before it is enriched or represented in articles; a personal reference is neither vault-searchable nor compilable until promoted.
- Ordinary library text search is metadata search: article title/précis and source title/author. Articles sort alphabetically, sources by latest update, and references newest-first in independent 50-item pages.
- Live library lists exclude archived articles. Direct retained archived reads show a successor link when the topic has one and an explicit no-successor message otherwise.
- Durable target IDs and library filters belong in routes/query strings; active vault, credentials, theme, open panels, drafts, selection chips, and most transient controls do not.
- Library text search writes trimmed `q` after a 300 ms debounce with history replacement. Library type/tag are URL state; the sessions-list filter is local and reload-ephemeral.
- First-session and pipeline launch shims replace themselves with `/sessions/{id}` and `/pipeline/runs/{id}` so Back does not revisit an auto-submitting or half-resolved launch.
- Preview selection is local: Escape closes it. Below 1200 px it overlays the page (full width at the narrowest size, 370 px from `md`); at 1200 px and above it docks beside the page.
- Sessions are vault-scoped for evidence but personal to their creator: even another member or vault owner receives not found when reading or appending someone else's session.
- Server acceptance writes a pending exchange before detached generation. Running replies persist full versioned answer/evidence snapshots (token flush no more often than 125 ms); the tail polls at 100 ms and browser reconnect delay grows from 1 to 10 seconds.
- Navigation or client-stream abort does not stop generation. A server restart marks pre-existing running replies failed with `interrupted by server restart` rather than resuming generation.
- Session storage is append-only. Pending and final events share an exchange id; reads and Markdown keep the latest exchange version. Main sessions list newest-update first in 50-item pages.
- Anchored origin sessions are document notes and stay out of the main sessions list. Unanchored document-origin sessions remain in the main list and also appear with the document.
- `/pipeline/runs/{id}` is the durable run route. Bare `/pipeline`, `?url=`, and browser navigation state are launch resolvers and replace themselves after a run is known.
- Runs are pending/running/completed/failed/cancelled and triggered by staged files, URL, or manual compile. A second compile request coalesces onto an existing undispatched vault intent.
- The compile reconciler runs at startup and every 5 seconds; default dispatch concurrency is one. Journaled staged-ingest/compile activities resume across process restart, while a run older than 120 seconds without a pending intent or matching journal becomes failed.
- Pipeline snapshots are checked every 100 ms with about 30-second heartbeats; browser reconnect delay grows from 1 to 10 seconds. Reopening a terminal run receives its snapshot and closes.
- Backend phase status, not a numeric step total, is the completion authority. Visible stages map source_ingest→Uploading, ingest→Indexing, extract→Reading, abstract→Synthesizing, derive→Connecting, render→Writing, verify→Checking, publish→Publishing.
- Cancellation marks terminal state first and is idempotent, but it is cooperative at activity/side-effect boundaries and does not promise rollback of completed uploads, provider calls, or writes.
- Idle home autofocuses one single-line question input; blank text does nothing, Enter and **query** are equivalent, and an empty focused input can show the three newest-updated recent sessions.
- The default query configuration searches the vault and has open-web search disabled. The visible query control exposes no model, scope, or attachment choice.
- A first question appears optimistically, then becomes durable at pending-exchange acceptance. Pre-acceptance failure removes the exchange, restores idle home with the typed text, and currently shows no inline error.
- While a running reply has no answer, Thinking is open with **traversing knowledge base…**; first answer text collapses it to settled evidence counts unless the user explicitly toggled it.
- Pending evidence pulses and is noninteractive. Settled article/raw/link cards can open full documents, exact chunk ranges, or connection lists; search and filter badges remain descriptive.
- Streaming renders stable Markdown through the latest blank line outside a code fence, reparses only the unfinished tail, and disables Great Minds text-selection actions until terminal state.
- A failed no-answer reply shows **reply interrupted** and its error; a failed reply with partial text currently renders the text without surfacing the stored error.
- The main follow-up bar exists only in `done`. A selection must trim to at least five characters and remain inside one rendered answer block before **+ follow up** can create a chip.
- Follow-up chips keep full quotes but visually truncate after 42 characters. Submission maps each to `re: "…"`, appends trimmed free text, and joins parts with ` — `; this composed string is the visible and stored question.
- Follow-up submit clears text and chips before server acceptance. If creation fails, the optimistic exchange rolls back but the draft is currently lost.
- A session BTW is anchored by selected quote, full containing block, and Markdown source offset. Its empty shell and typed text are local until the first side turn is accepted; a blank blurred shell is removed.
- The first BTW model turn receives main history plus `Passage:`/optional `Highlighted:` context; later turns receive main history plus that thread's prior turns. BTW turns never enter future main-line history.
- BTW replies run independently of main session phase, so different side threads and a main reply can run concurrently. One thread permits only one running side turn at a time, has no Stop, and reconnects by durable reply id.
- Pending and final BTW events repeat the whole thread. Replay currently identifies one logical thread by parent exchange id plus quote, so identical quotes in different blocks can collide after reload.
- A pre-acceptance BTW failure leaves a local interrupted turn and loses the cleared input; a failed reply with partial text hides its error just like a main reply.
- **save as source** copies only one durable main answer to `raw/sessions/{exchange id}.md`, regenerates paragraph anchors, records session/exchange/question/origin provenance, registers a `session` source, and creates or coalesces a compile intent.
- Exchange promotion is idempotent by destination: an existing source or pending proposal is returned without rewrite or another compile. The session receives no saved marker, so reload shows the action again.
- Fresh owner ingests and editor proposals return `title: null`, but the browser currently requires a string. The first successful mutation therefore displays a response-validation error after committing; a post-reload repeat can show success through an exchange-id fallback.
- The promotion path requires editor access but currently omits the parent session-creator check used by read/append, creating a suspected private-session promotion defect for another editor who knows both ids.
- Owner file review hashes recognized files four-at-a-time, auto-deselects later same-batch hashes and server-known client hashes, and stores the confirmed `File` objects/run id only in `/pipeline` browser history state until a durable run exists.
- Default local/direct upload is sequential and accepts UTF-8 Markdown/plain text plus HTML, despite the review recognizing many office/PDF/data formats. It discards displayed folder paths and client hashes, derives `raw/docs/{slugified base}.md`, and can overwrite same-named sources.
- R2 staged upload signs for one hour, PUTs unique hashes four-at-a-time, then starts a durable staged-ingest workflow. Accepted source paths use the first 12 hash characters; staged leftovers expire after one day.
- Review selected counts include unrecognized/hash-error rows that confirmation silently omits. Partial staged upload/conversion failures can also be omitted when some files continue, and pre-run **retry** starts compile rather than retrying files.
- Before run creation, file upload has no cancel or durable recovery. Its async resolver is not lifecycle-aborted and resolves the active vault separately on each request, creating navigation and cross-tab vault-drift risks.
- URL ingest trims only in the browser, prefixes lowercase-scheme-missing input with HTTPS, permits HTML/plain text, enforces public-address checks on redirects, a 30-second fetch timeout, and a 25 MiB body cap.
- URL launch creates a durable run first but waits synchronously for fetch/conversion/storage before returning its id. The initiating page shows skeletons with no cancel/reconnect; reload of unresolved `/pipeline?url=…` starts a new run/fetch.
- URL sources use `raw/docs/{slugified submitted-path stem or doc}.md` with no URL dedupe/collision suffix. Host/query/fragment and redirect destination do not distinguish the path, so unrelated URLs can overwrite.
- Visible URL ingest is owner-only, but the server route currently allows any vault member—including viewers—to write the shared source and start the run.
- A pre-resolution URL error leaves a durable failed run but the browser lacks its id; its **retry** starts a manual compile rather than refetching the URL.
- Health exposes **update now** only for dirty topics and disables it only during the creation request, not for another active run. Compile requests coalesce with an undispatched intent or queue behind dispatched work.
- Pipeline lays out eight disclosure stages from complete snapshots, auto-opens current/completed/failed rows, smoothly centers a newly active stage, retries transport drops, and treats stream-opening HTTP errors as terminal page errors.
- **cancel** has no confirmation/pending/error state and is cooperative; **retry**/**run again** create a whole new manual run and likewise have no pending/error handling. Compile/cancel remain member-wide server operations.
- Completion waits 300 ms, reports the total live articles carrying the run id but lists at most eight, and silently omits result-query failures. Zero such articles is labeled **nothing changed** even if non-render work changed.
- A queued terminal snapshot with empty backend phase is discarded before terminal-status handling; the following SSE `done` frame marks overall success, so a queued cancellation/failure can incorrectly show **Knowledge base updated**.

Add load-bearing facts here as each foundation is completed: defaults, limits, timing, durable boundaries, role restrictions, route ownership, recovery rules, and which research document owns each state.

## Order of work

1. Write and revise `reading-room/open-an-external-article.md` as the pilot. It must use all eight sections and set the depth bar.
2. Write `foundations/` in this order: access and vault context; content model; navigation and page state; research session model; background work. Add every shared fact to the established list above as it becomes owned by a foundation.
3. Read the complete session UI and state flow before drafting `research/`. State ownership is:
   - `ask-a-question.md` owns composition, submission, creation of the exchange and first durable session, and the transition into waiting;
   - `streamed-answer-and-evidence.md` owns waiting/searching, evidence snapshots, streamed answer replacement, reconnect, completion, and interruption;
   - `follow-up.md` owns selected chips and the next main-line exchange after completion;
   - `btw-threads.md` owns anchored side-thread creation, turns, persistence, reconnect, and dismissal;
   - `save-an-answer-as-a-source.md` owns exchange promotion, owner ingestion versus editor proposal, idempotent repeats, and the resulting source provenance.
4. Draft `sources/`, then `library/`, `health/`, and `cross-cutting/`. These are independent enough to parallelize after the foundations and research exemplars exist, but review every result for vocabulary, links, established facts, and complete fixed tables.
5. Run the consistency pass: one owner per behavior, no contradictions, every glossary term defined, fixed rows and order preserved, footers present, structure and coverage exact, and every relative link resolvable with the installed skill's `check-links.py`.
6. Create `verification/README.md` and all four checklist files. Use stable per-document prefixes and one observable claim per row. Do not mark a document verified from source reading or automated checks alone.
7. Build `bug-triage.md` from all suspected defects, deduplicate by root cause, and pin every cause to source files and lines.

## Working rules

- Commit after each document or coherent group with `docs: add {path}` or `docs: revise {path}`. The source repository uses plain commit subjects and does not require AI attribution; this description repo follows that convention.
- Never modify `/Users/kijana/Documents/Code/great_minds`. It is read-only source material for this work.
- Do not add files outside the README structure without updating the structure and coverage table first.
- When behavior cannot be determined from code and tests, state what is known, add the remainder to open questions, and move on. Do not guess and do not block.
- The pilot should be roughly 150–200 lines. The research documents may run 200–300 lines. Completeness matters more than length; every phase, context variant, interrupt row, and cross-cutting concern must be accounted for.
- If the structure proves wrong, revise the README structure and coverage table before adding, splitting, moving, or merging a document, and explain the change in the commit message.

The drafting pass is complete when the coverage table has no `not started` feature rows. The project is complete when consistency checks pass, verification checklists and triage exist, and all work is committed.
