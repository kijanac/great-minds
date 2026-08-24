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

Add load-bearing facts here as each foundation is completed: defaults, limits, timing, durable boundaries, role restrictions, route ownership, recovery rules, and which research document owns each state.

## Order of work

1. Write and revise `reading-room/open-an-external-article.md` as the pilot. It must use all eight sections and set the depth bar.
2. Write `foundations/` in this order: access and vault context; content model; navigation and page state; research session model; background work. Add every shared fact to the established list above as it becomes owned by a foundation.
3. Read the complete session UI and state flow before drafting `research/`. State ownership is:
   - `ask-a-question.md` owns composition, submission, creation of the exchange and first durable session, and the transition into waiting;
   - `streamed-answer-and-evidence.md` owns waiting/searching, evidence snapshots, streamed answer replacement, reconnect, completion, and interruption;
   - `follow-up.md` owns selected chips and the next main-line exchange after completion;
   - `btw-threads.md` owns anchored side-thread creation, turns, persistence, reconnect, and dismissal.
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
