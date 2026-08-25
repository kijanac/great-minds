# Great Minds core research product description

A written description of the core owner experience in Great Minds: what the user sees, what they can do, and exactly what happens when they do it.

## Purpose

Great Minds is, from the user's point of view, a large state chart. The user moves through it by arriving on pages, choosing a vault, adding source material, submitting questions and forms, following links, and waiting for streamed or background work. Most of that behavior is defined implicitly across Svelte components and state objects, HTTP handlers, durable workflows, database-backed services, and integration tests. There is no single place that says, in plain language, “when the user does X, this is what happens, and this is what happens if they do Y halfway through.”

This project is that place. It describes the authenticated desktop web experience for a vault owner using one existing vault in the default configuration. The core journey begins with source material, continues through compilation and library browsing, and ends in source-grounded research sessions.

The documents are for people who need to understand or change the product: designers, engineers, writers, testers, and anyone evaluating whether a behavior is intentional. They are written from the outside in. They describe the experience, not the implementation.

### What this is not

- Not API documentation. The source repository's [`API.md`](../great_minds/API.md) and the Effect HTTP API declarations in `packages/domain/src/index.ts` own the protocol surface.
- Not organized by package. The web, server, domain, database, and workflow packages are not described separately. A behavior is described once, wherever the user encounters it.
- Not a technical design document. Where a technical detail is critical to understanding the experience, it appears in a block quote labeled `Technical note:` and nowhere else.
- Not a description of every Great Minds surface. Account setup, vault administration, member and proposal workflows, credential management, and the public recipient view are named exclusions below.

## Conventions

- Describe the experience, not the code. “The question remains visible while Great Minds searches” rather than “the session object changes phase.”
- Technical detail goes in block quotes prefixed with `Technical note:`. Use it only when the mechanism changes what the user would expect.
- Use sentence case for headings.
- Name the vocabulary consistently. The [glossary](glossary.md) is the source of truth for terms such as *vault*, *source*, *article*, *reference*, *session*, *exchange*, *reply*, and *compile*.
- Every feature document ends with the commit of the Great Minds source repository it was drafted against and a list of open questions.
- When a behavior is surprising, say so and say why it is that way if the reason is known. Do not smooth it over.

## The work to be done

Each document describes one user-facing feature or one foundation that other features depend on. Features range from the full question-and-answer loop to the small form that opens an external article, but each is described in full, including its edge cases and its interactions with other features.

### Document template

Every feature document follows the same skeleton so that documents are comparable and nothing is skipped.

1. **Summary.** One paragraph describing the feature abstractly and identifying where the user meets it.
2. **The simple case.** The common path in prose.
3. **The interaction, event by event.** The five phases of a Great Minds task: **arrive**, **leave without acting**, **begin**, **while in progress**, and **finish**. “Task” is deliberately broad enough to cover a form submission, a streamed research turn, a page-level selection, and a background operation. Each document includes a small Mermaid `stateDiagram-v2` showing only the states the user passes through.
4. **Context and state variants.** The same rows in every feature document, with columns for the state at arrival and for a change while the task is active:
   - account role and access;
   - vault state: empty, ready, or running background work;
   - target state: new, existing, stale, missing, or already changed;
   - entry context: direct URL, in-app navigation, or document-anchored entry;
   - input and viewport: keyboard or pointer, desktop or narrow viewport.
5. **Cancel and interrupt.** The same checklist in every document, in this order:
   - Escape, Cancel, or Stop;
   - navigation to another Great Minds page;
   - browser Back or Forward;
   - page reload;
   - tab or window closed;
   - network lost;
   - request failure or timeout;
   - authentication session expires;
   - the target changes in another tab;
   - the target changes through another member;
   - browser autofill, paste, drop, or another input channel writes into the interaction;
   - the window loses focus.
6. **Interactions with other systems.** The same concerns in this order: **permissions and roles**, **validation and error display**, **unsaved work and history**, **optimistic changes and rollback**, **offline and reconnection**, **notifications**, **URL and navigation state**, **multi-tab and multi-user behavior**, **accessibility and keyboard use**, and **external side effects**.
7. **Edge cases.** Anything a user could notice that is not covered above.
8. **Open questions and verification.** Behavior that needs a running-product check, behavior that may be a defect, assumptions, and the source commit.

The cancel-and-interrupt section matters most. Asking the same questions of every feature is how gaps and inconsistencies become visible.

### Method

For each document:

1. Read the relevant Svelte route, component, state object, and hook under `web/src/routes` and `web/src/lib`.
2. Read the matching API client and the server service or workflow under `packages/server/src`.
3. Read the integration tests in `packages/server/test`. `write-endpoints.integration.test.ts`, `read-endpoints.integration.test.ts`, `query.integration.test.ts`, `jobs-http.integration.test.ts`, `sessions.test.ts`, `shares.integration.test.ts`, and the workflow-resume tests are close to executable specifications of edge cases.
4. Draft the document from the user's point of view.
5. Try ambiguous behavior in the local web app at `http://localhost:5173` when the required database and provider setup is available. Tests settle what happens; the running product settles what is visible while it happens and how the timing feels.
6. Record the source commit.

### Verification

Drafting reads the code; verification watches the product. The `verification/` directory holds one checklist per cluster of documents. Each item is one observable claim with setup, steps, expected result, a priority, and the browser or condition it needs. A tester runs the checklist against the owner surface, records `pass`, `fail`, or `blocked`, and files every failure in `bug-triage.md` with the item's ID. A document moves from `drafted` to `verified` only when every P1 and P2 item for it has passed or been filed.

`bug-triage.md` is the other half: every behavior the documents flag as a likely defect, deduplicated, with reproduction steps, the reason in the source, a severity, and the decision the product team needs to make. Entries confirmed in the running app carry a Status line.

### Order of work

1. **Pilot: opening an external article.** This small URL form includes native validation, a remote request, durable personal content, error display, and navigation to a reader. It settles the template, tone, and depth.
2. **Foundations.** Access and vault context, the content model, navigation and page state, the research session model, and background work. Everything else links to these.
3. **Research sessions.** Asking, streaming and inspecting evidence, following up, and creating BTW threads are the hardest and most interconnected part of the experience.
4. **Sources, library, health, and sharing/export.** These can be drafted once the foundations and research exemplars own the shared facts.
5. **Consistency, verification, and triage.** Links, vocabulary, fixed tables, checklists, and suspected defects are reviewed across the whole set.

Progress is tracked in the [coverage table](#coverage).

### Scope decisions

- **Surface.** The authenticated desktop web app for a vault owner, using one existing vault at default settings. The source is the Great Minds repository at commit `c8c9e57`; the local verification surface is `http://localhost:5173` with the TypeScript API on port 8000.
- **Core journey.** Adding source material, compiling it into a library, reading source and synthesized content, asking grounded questions, inspecting evidence, following up, and reviewing vault health are in scope.
- **Account and vault administration.** Email-code and passkey sign-in, first-vault onboarding, creating or deleting vaults, changing vault configuration, inviting members, transferring ownership, and reviewing member proposals are out of scope. They are a coherent settings and administration surface and should receive a separate description rather than thin appendices here.
- **Other roles.** Editor and viewer journeys are out of scope. Their restrictions are recorded only where the owner UI branches on role and therefore affects the scoped experience.
- **Public recipient view.** Creating, listing, and revoking a share is in scope as an owner action. Reading `/s/{token}` without an account is a separate public surface and is out of scope.
- **Mobile-specific layout.** Narrow-view behavior that is explicit in the code is recorded, but touch ergonomics and device-specific browser behavior require a later verification pass.
- **Provider wording.** Model-generated prose is nondeterministic. The documents describe the structure, persistence, evidence, progress, and failure behavior of a reply, not its exact wording.
- **Interaction shape.** The unit of interaction is a task, with phases **arrive**, **leave without acting**, **begin**, **while in progress**, and **finish**. The variant rows, interrupt list, and cross-cutting order are fixed as written above.
- **Numbered rules.** These are prose documents, not numbered specifications. Stable heading anchors are enough for cross-references.

## Structure

```text
README.md                              this file
goal.md                                standing instructions for drafting
AGENTS.md, CLAUDE.md                   entry points for agents
glossary.md                            shared vocabulary
bug-triage.md                          suspected defects, repros, causes, and decisions

verification/
  README.md                            hand-verification protocol
  foundations-and-reading-room.md      foundations and the pilot
  research.md                          question, reply, follow-up, and BTW checklists
  sources-and-library.md               ingest, compile, library, reader, and health checklists
  sharing-and-export.md                owner sharing and export checklist

foundations/
  access-and-vault-context.md          the signed-in owner, active vault, and role boundary
  content-model.md                     sources, articles, references, tags, and health states
  navigation-and-page-state.md         routes, panels, URL state, and restored client state
  research-session-model.md            sessions, exchanges, replies, evidence, and BTW threads
  background-work.md                   ingest jobs, compile runs, progress, cancellation, and durability

reading-room/
  open-an-external-article.md          pilot: fetch an external URL into the personal reading room

research/
  ask-a-question.md                    submit the first or next source-grounded research turn
  streamed-answer-and-evidence.md      waiting, streamed prose, source cards, citations, and interruption
  follow-up.md                         follow up with free text and selected answer excerpts
  btw-threads.md                       anchored side conversations inside an answer
  save-an-answer-as-a-source.md        promote a completed exchange into vault source material

sources/
  add-files.md                         select or drop files, review them, upload, and queue processing
  add-a-url.md                         fetch a URL into the active vault and follow its ingest job
  compile-the-vault.md                 start, observe, and cancel the vault-wide compile pipeline

library/
  browse-search-and-filter.md          browse articles, sources, tags, types, and personal references
  read-content.md                      read full vault documents and personal references with side threads
  manage-content.md                    delete sources, request deletion, rename references, and promote them

health/
  review-vault-health.md               inspect stale, missing, and orphaned material and request an update

cross-cutting/
  share-and-export.md                  create and revoke owner shares, print, and export session markdown
```

## Coverage

Status is one of `not started`, `drafted`, or `verified`.

| Document | Status |
| --- | --- |
| glossary.md | drafted |
| bug-triage.md | not started |
| verification/ (4 checklists) | not started |
| foundations/access-and-vault-context.md | drafted |
| foundations/content-model.md | drafted |
| foundations/navigation-and-page-state.md | drafted |
| foundations/research-session-model.md | drafted |
| foundations/background-work.md | drafted |
| reading-room/open-an-external-article.md | drafted |
| research/ask-a-question.md | drafted |
| research/streamed-answer-and-evidence.md | drafted |
| research/follow-up.md | drafted |
| research/btw-threads.md | drafted |
| research/save-an-answer-as-a-source.md | drafted |
| sources/add-files.md | drafted |
| sources/add-a-url.md | drafted |
| sources/compile-the-vault.md | not started |
| library/browse-search-and-filter.md | not started |
| library/read-content.md | not started |
| library/manage-content.md | not started |
| health/review-vault-health.md | not started |
| cross-cutting/share-and-export.md | not started |

## Reference

The source of truth is the Great Minds repository at `/Users/kijana/Documents/Code/great_minds`, commit `c8c9e57`. The relevant locations are:

- `web/src/routes`: the pages and route-level access gates for the scoped web surface.
- `web/src/lib/components`: the visible forms, readers, shelves, progress displays, session thread, panels, menus, and dialogs.
- `web/src/lib/session.svelte.ts` and `web/src/lib/hooks`: client interaction state, restored sessions, active-vault state, URL-backed filters, jobs, and document state.
- `web/src/lib/api`: browser-facing request, authentication refresh, schema, and stream behavior.
- `packages/domain/src/index.ts`: user-visible request and result shapes, roles, states, limits, and the HTTP route inventory.
- `packages/server/src`: persistence services, query/reply orchestration, ingest and compile workflows, storage, conversion, sharing, and access checks.
- `packages/server/test`: behavioral and integration tests used as executable specifications.
- `packages/database/src/schema.ts`: durable state and relationships when persistence semantics affect what a user can observe.
- `justfile`, `docker-compose.yml`, and `web/vite.config.ts`: the local verification entry points.
