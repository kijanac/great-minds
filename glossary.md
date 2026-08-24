# Glossary

The vocabulary used across these documents. When a document uses one of these words, it means exactly this.

## The surface

**Great Minds.** The browser application that turns a vault of source material into a browsable library and supports source-grounded research conversations. In this description, “Great Minds” means the authenticated desktop web surface, not the API, worker, public share page, or deployment as a whole.

**Signed in.** The browser holds an access token and a refresh token for an account. A signed-in page may refresh an expired access token once and retry its request; losing both usable credentials returns the user to the sign-in surface.

**Owner.** The one member who owns a vault. The owner can add source material, request compiles, remove sources directly, and perform the other core actions in this description. Editor and viewer behavior is outside the primary scope.

**Active vault.** The vault whose identifier the browser currently stores and sends with vault-scoped requests. Switching the active vault changes the content, sessions, jobs, and permissions visible on subsequent queries without changing the account.

**Vault.** A named, member-scoped body of source documents, synthesized articles, research sessions, configuration, and background runs. A vault is the boundary for search and compilation: a question on the home page is asked across the active vault, not across every vault the account can access.

## Content and the library

**Content.** The collective user-visible material in a vault or personal reading room. Use a more specific term—*source*, *article*, or *reference*—when the distinction matters.

**Source.** Material added to a vault from a file, URL, promoted reference, or saved research exchange. A source retains provenance and source metadata where available and is input to later compiles and grounded questions.

**Article.** A synthesized vault document written around a topic during a compile. The UI sometimes calls these “wiki articles”; these documents use *article* unless distinguishing them from source documents.

**Document.** A full readable source or article at a vault path. “Document” is the neutral term when reader behavior is the same for both kinds.

**Reference.** A personal article fetched from an external URL into the signed-in user's reading room. A reference is not part of a vault until the user promotes it; it remains account-scoped when the active vault changes.

**Reading room.** The personal-reference shelf inside the library. It belongs to the account rather than the active vault and contains references opened from external URLs.

**Library.** The page that brings together vault articles, vault sources, and the personal reading room. It supports type filters, tag filters, text search for vault content, incremental loading, preview panels, and full readers.

**Tag.** A label attached to a source or article and exposed as a library filter. A tag filter is stored in the page URL. Personal references do not carry tags and therefore disappear from the reading-room shelf while a tag filter is active.

**Source type.** The source category shown as a library filter, derived from source metadata. “All” includes articles and sources; “Articles” excludes sources; “Reading room” switches to account-scoped references.

**Chunk.** A numbered searchable section of a vault document. A source card may point to one or more chunk ranges rather than the entire document; opening that card shows only the cited ranges until the user opens the full document.

**Archived article.** An article retained for an older topic state but no longer the live article for that topic. A reader can indicate that it has been superseded and point to the replacement when one exists.

## Health

**Vault health.** The set of library conditions that Great Minds marks as needing attention: orphaned articles, dirty topics, and unmentioned links. The health badge is the sum of those reported items, not a general server-health indicator.

**Orphaned article.** An article that the health report considers disconnected from the current live topic graph. It remains readable but appears in the health review.

**Dirty topic.** A topic whose current source membership or content no longer matches the article generated for it. A compile can refresh its article.

**Unmentioned link.** A relationship the health report found between two articles that is not represented in the source article's body. The health page names both ends so the owner can inspect the gap.

## Research sessions

**Session.** A durable research conversation in one vault. A session begins with its first question, contains one or more exchanges and optional BTW threads, and may have an origin document. The browser route becomes `/sessions/{id}` when the first exchange has created the durable session.

**Origin.** The document context from which a session began. An origin records a vault or personal document path and may include selected text, paragraph text, and a paragraph index. Follow-up exchanges remain in the same session but do not create a new origin.

**Exchange.** One main-line question and its resulting answer inside a session. An exchange owns the question, evidence display, streamed answer, and any BTW threads anchored inside that answer.

**Reply.** The durable generation record for one exchange or one BTW turn. It moves from running to completed or failed and exposes replaceable snapshots so a browser can reconnect without reconstructing partial token events.

**Research turn.** The user-facing lifecycle from composing one question through the completion or interruption of its reply. In a main session, one research turn creates one exchange.

**Evidence.** The source material Great Minds consulted or surfaced for a reply. Evidence appears as source cards and citations; it can include vault articles, raw source ranges, web-search results, generated queries, and linked-article sets.

**Source card.** A compact evidence control shown while Great Minds searches or above the answer. Opening a vault source or article card reveals its content in a side panel; some non-document cards describe searches or links instead.

**Citation.** A link embedded in generated prose that points to a vault path, optionally at a chunk. On the session page, internal citations are intercepted into the evidence panel before the user chooses a full reader.

**Thinking section.** The collapsible or progressive area that displays evidence gathered for an exchange before or alongside the answer. It describes observable source activity, not private model reasoning.

**Follow-up.** A new main-line exchange submitted after the previous reply completes. It can combine free text with one or more selected excerpts represented as selection chips.

**Selection chip.** A quoted excerpt selected from an answer and queued above the follow-up input. Removing a chip changes only the unsent follow-up; submitting turns each chip into explicit `re:` context in the next question.

**BTW thread.** A side conversation anchored to selected text inside one answer. “BTW” is the product's label. Its turns are stored with the owning exchange and do not replace the main session's follow-up path.

**Interrupted reply.** An exchange whose durable reply is no longer running but has no answer text. The thread shows an interruption message and, when available, the stored error rather than an empty answer.

## Background work

**Ingest.** The process that turns an uploaded file or fetched URL into a stored, indexed source document. File ingest may begin with direct staged uploads; URL ingest fetches and converts the remote document before indexing it.

**Staged file.** A selected file that has been hashed and, when needed, uploaded to temporary storage but has not yet completed source processing. Duplicate checks use the client-computed content hash before upload.

**Ingest job.** A durable background run triggered by staged files or a URL. It has a status, phase, ordered progress steps, timestamps, and an error field, and it can lead into a compile request.

**Compile.** The vault-wide process that extracts ideas from sources, synthesizes and canonicalizes topics, writes or reuses articles, derives links, checks the result, and publishes the new snapshot. A compile operates on the active vault's durable content, not on unsent browser state.

**Pipeline run.** The durable record shown on the pipeline page for an ingest or compile operation. A run can be pending, running, completed, failed, or cancelled.

**Active pipeline.** A pending or running pipeline run for the active vault. The home and health surfaces use its presence to prevent or redirect actions that would start conflicting work.

**Phase.** A major pipeline section such as ingesting, extracting, synthesizing, writing, connecting, checking, or publishing. A phase is complete only when its phase status says completed; numeric step totals alone do not advance it.

**Progress step.** A named row inside a pipeline phase. It has a stable key, a user-facing label, pending/running/completed/failed status, optional done and total values, and optional detail text.

**Terminal state.** Completed, failed, or cancelled. A terminal pipeline or reply no longer expects live progress, although a new run or reply can start later.

## Page and interface state

**Home.** The default authenticated route. Before a question it shows the active vault, the query input, recent sessions on focus, and owner-only source-ingest controls. During a session it becomes the session thread surface.

**Reader.** The full-page document or reference view reached from a panel, library row, origin link, or direct URL. A vault reader uses `/doc/{path}`; a personal-reference reader uses `/refs/{path}`.

**Preview panel.** The side panel used to inspect a source card or library item without leaving the current page. Closing it preserves the underlying page state; choosing full screen navigates to the reader.

**Page state.** User-visible state represented by the route or query string, including the current session, document path, library type, search query, and tag filter. Page state should survive Back and Forward; purely local controls such as an open preview panel generally do not.

**Client state.** Browser-held state not yet represented by a durable server record, such as text in an input, selected follow-up chips, an open dropdown, or a pending selection popover. Reloading may discard client state unless a document says otherwise.

**Durable.** Stored outside the current page so it can be read after reload or from a later visit. A durable reply snapshot, session event, source, or pipeline run can outlive the browser request that created it.

**Pending.** Accepted or optimistically represented but not terminal. A pending control is commonly disabled against duplicate submission while the server or background worker continues.

**Saved.** Successfully written to the durable record that owns the feature. “Saved” does not mean compiled: a source can be saved and indexed while its effect on articles still awaits a compile.

## The task lifecycle

**Task.** The common unit used by these documents for one user intention with a beginning, a potentially extended middle, and an end. Depending on the feature, a task is a form submission, research turn, page-level selection, upload, or background request.

**Arrive.** The first task phase. The document states the route or control the user reaches, what loads, what is focused or prefilled, and what access and target state are established.

**Leave without acting.** The short task path. The user departs or dismisses the feature before making a change or starting remote work; the document states explicitly whether anything is recorded.

**Begin.** The transition into active work: the first edit, submit, selection, upload, or durable request. This phase identifies what is fixed for the remainder of the task.

**While in progress.** The extended phase in which validation, upload, streaming, polling, or other visible work continues. The document states what remains interactive and what is disabled.

**Finish.** The success or failure boundary where durable effects, rollback, messages, and destination are settled.

## Context and state variants

**Account role and access.** Whether the current account owns the vault and whether it can read or mutate the target. In this description the default is owner access; other roles are recorded only where the scoped UI branches.

**Vault state.** Whether the active vault is empty, ready for work, or already has a background run in progress. The same control can be hidden, disabled, redirected, or produce a different result across these states.

**Target state.** Whether the object acted on is new, existing, stale, missing, archived, or already changed. The target is established at arrival or submission and may become invalid while a request is in flight.

**Entry context.** How the user reached the feature: direct URL, in-app navigation, or a document-anchored action. Entry context can determine origin metadata, Back behavior, and what returns after completion.

**Input and viewport.** Whether the action uses keyboard, pointer, paste, drop, or file picker, and whether the viewport is wide enough for a docked panel. These are observable variants even when the durable result is identical.

## Events that cancel or interrupt a task

**Explicit abort.** Escape, a visible Cancel button, or a visible Stop control invoked by the user. These words are not interchangeable: Cancel normally closes or discards local work, while Stop requests termination of already-running durable work.

**In-app navigation.** Choosing another Great Minds route while a task is open or running. The destination loads in the same tab; whether the work continues depends on whether it was only client state or already durable.

**Browser history navigation.** Browser Back or Forward. It restores route and URL state but does not promise to restore local drafts, open panels, selections, or the exact point in a stream.

**Reload.** Replacing the current page with a fresh instance at the same URL. Durable sessions, replies, sources, and runs can be recovered; unsent client state generally cannot.

**Page close.** Closing the tab or window. The browser cannot be relied on to finish ordinary in-flight requests during close, while accepted durable work can continue without the page.

**Network loss.** The browser becomes unable to reach the API while the page remains open. It is distinct from an application request that completed with an error.

**Request failure.** The API, provider, conversion, storage, or worker returns or records an error or exceeds its timeout. The feature must say what remains, what becomes retryable, and where the error is shown.

**Authentication expiry.** A request receives an unauthorized response and the browser cannot refresh its access token. The user loses access to the scoped route and must sign in again; durable work already accepted by the server is not thereby cancelled.

**Another-tab change.** The same account changes or deletes the target in another tab. Great Minds does not provide a universal live-sync channel, so many pages learn about the change only on refetch, invalidation, navigation, or failure.

**Another-member change.** A different vault member changes or deletes the target. It is distinct from another-tab change because permissions and proposals may alter the outcome.

**Alternate input.** Browser autofill, paste, drag and drop, a file picker, or another input channel writes into an interaction. Documents state whether this follows the same validation and submission path as typing or clicking.

**Focus loss.** The browser window or current control loses focus without navigating. Focus loss may close transient controls or trigger native validation, but it does not itself cancel durable work unless a document says so.

## Sharing and export

**Share.** A revocable, optionally expiring public token for one session or personal reference. Creating the same active share configuration can reuse the existing share rather than minting a second equivalent link.

**Annotation.** A stored BTW thread on a personal reference. A reference share can include or omit these anchored conversations; a session share exports the session itself.

**Session markdown.** The server-rendered text export of a saved session. It is available only after the session has a durable identifier; printing to PDF uses the browser's print path instead.
