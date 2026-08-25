# Bug triage

A consolidated list of defects and inconsistencies raised by the feature documents. Every cause below was read from Great Minds source at commit `c8c9e57`; Status lines are added only after hand verification and may also record later fixes. The list is intentionally separate from product decisions: `fix` means the expected behavior is clear, while `product call` means current behavior is observable but reasonable teams could choose a different contract.

## Summary

The drafting pass raised 50 deduplicated items: 16 high, 30 medium, and 4 low. The high-severity cluster is dominated by scope/authorization leaks, user work or selected files being silently lost, successful mutations reported as failures, durable terminal state displayed incorrectly, and public-link behavior that can expose more content than the creator saw at creation. Medium items concentrate around missing error/recovery states, lifecycle work that outlives its page, stale active-vault context, and inconsistent content metadata. Three items have been hand-confirmed; their Status lines also record the later fixes.

| ID | Title | Severity | Area | Decision needed | Issue |
| --- | --- | --- | --- | --- | --- |
| B-01 | Personal-reference Query grounds and links the session as vault content | high | research/reader | fix | — |
| B-02 | Follow-up failure destroys the typed text and every selection chip | high | research | fix | — |
| B-03 | The first successful save-as-source is reported as a technical error | high | research/source | fix | — |
| B-04 | An editor can promote another creator's private session answer | high | privacy/source | fix | — |
| B-05 | Viewer/editor membership permits shared mutations, provider work, and cancellation | high | authorization | resolved | — |
| B-06 | A failed Health request reports the wiki as healthy | high | health | fix | — |
| B-07 | Different URL sources with the same path stem overwrite one another | high | source ingest | fix | — |
| B-08 | Direct file ingest discards folders and overwrites same-base files | high | source ingest | fix | — |
| B-09 | File review and staged ingest can silently omit files counted as selected | high | source ingest | fix | — |
| B-10 | A failed reply with partial prose looks successfully completed | high | research | fix | — |
| B-11 | A queued cancelled/failed run can display Knowledge base updated | high | pipeline | fix | — |
| B-12 | URL launch cannot reconnect, reloads duplicate work, and Retry does not retry the URL | high | URL ingest | fix | — |
| B-13 | A share silently expands to future private session turns or reference notes | high | sharing | product call | — |
| B-14 | Share requests can create unseen or multiple active bearer links | high | sharing/security | fix | — |
| B-15 | Public share bearer tokens are stored in plaintext | high | sharing/security | fix | — |
| B-16 | Another-tab vault switch can retarget an in-progress multi-file operation | high | vault/source ingest | fix | — |
| B-17 | Initial question creation errors have no visible explanation | medium | research | fix | — |
| B-18 | BTW first-turn failure loses text and leaves a malformed local thread | medium | research | fix | — |
| B-19 | Two BTW threads with the same quote collide after reload | medium | research | fix | — |
| B-20 | Long main answers and follow-ups have no follow-to-latest behavior | medium | research | product call | — |
| B-21 | Reader and evidence-panel failures are mislabeled as Not found | medium | reader/evidence | fix | — |
| B-22 | Library request failures and invalid type state render empty or blank | medium | Library | fix | — |
| B-23 | Pending document notes do not reconnect and appear interrupted | medium | reader notes | fix | — |
| B-24 | An unresolvable document note can become inaccessible | medium | reader notes | fix | — |
| B-25 | Full-reader metadata drops article tags and omits null-title fallbacks | medium | reader | fix | — |
| B-26 | File review recognizes formats that the active converter rejects | medium | source ingest | fix | — |
| B-27 | Direct-upload duplicate detection is both racy and ineffective on repeats | medium | source ingest | fix | — |
| B-28 | Client file upload has no real cancel/recovery and can navigate after leaving | medium | source ingest | fix | — |
| B-29 | Bare pipeline says No active job when several runs are active | medium | pipeline | fix | — |
| B-30 | Pipeline cancel/retry/stream errors lack truthful pending and failure state | medium | pipeline | fix | — |
| B-31 | Source deletion leaves compiled articles stale without queuing repair | medium | content management | product call | — |
| B-32 | Source deletion can commit database removal and then report storage failure | medium | content management | fix | — |
| B-33 | Reference promotion drops the chosen title, author, and publication date | medium | content management | fix | — |
| B-34 | Reference rename has stale-null and overlapping-request races | medium | content management | fix | — |
| B-35 | Personal references cannot be deleted in the authenticated web UI | medium | content management | product call | — |
| B-36 | Health counts and actions do not identify or reliably refresh affected content | medium | health | product call | — |
| B-37 | Sharing/printing/exporting a running session produces divergent incomplete artifacts | medium | sharing/export | fix | — |
| B-38 | Share management has no expiry/central inventory and annotation scope is broad | medium | sharing | product call | — |
| B-39 | Stale active-vault state has no global recovery and can reinterpret open routes | medium | navigation | product call | — |
| B-40 | Sign-in stores valid tokens before a failed vault load and then reports failure | medium | authentication | fix | — |
| B-41 | Save-as-source success state is local and disappears on reload | medium | research/source | fix | — |
| B-42 | URL ingest exposes the full URL in history and mislabels later-stage failures | medium | URL ingest | fix | — |
| B-43 | Compile completion truncates or hides results and overstates no-op status | medium | pipeline | fix | — |
| B-44 | Historical evidence resolves live source paths rather than answer-time content | medium | research/evidence | product call | — |
| B-45 | Durable research generation has no Stop action | medium | research | product call | — |
| B-46 | Dynamic progress and selection actions lack robust assistive semantics | medium | accessibility | fix | — |
| B-47 | Library count, wildcard, tag, and synthesis-pin semantics are misleading | low | Library | product call | — |
| B-48 | Clipboard and Markdown-export failures have no visible error | low | sharing/export | fix | — |
| B-49 | Pipeline pages omit the run context needed to identify work | low | pipeline | product call | — |
| B-50 | Small discovery/copy inconsistencies obscure notes and filtered content | low | UI copy/discovery | fix | — |

## High

### B-01: Personal-reference Query grounds and links the session as vault content

- **Where the user meets it:** The query bar at the top of `/refs/{path}`.
- **What happens / what was expected:** The reader sends only `q` and `origin`; Home hard-codes that origin to `vault`. The reply can fail to read the personal reference, and the resulting origin link uses `/doc/refs/…`. It should preserve `personal` scope exactly as anchored reference notes do.
- **Reproduce:** Create a reference containing a phrase absent from the vault, ask about it from the reader header, then inspect evidence and the **from** link in the saved session.
- **Why (from the code):** `web/src/lib/components/article-reader.svelte:236-240` forwards only the path; `web/src/lib/components/home-content.svelte:99-110` and `web/src/lib/session.svelte.ts:197-208` construct `origin_scope: "vault"`. By contrast, `web/src/lib/btw.svelte.ts:194-214` carries the reader's scope.
- **Severity:** `high`. It defeats the core grounding promise and records false provenance.
- **Decision needed:** `fix`. Carry origin scope in launch state/query and use it for query request, durable session origin, and return route.
- **Raised by:** [navigation](foundations/navigation-and-page-state.md#open-questions-and-verification), [ask](research/ask-a-question.md#open-questions-and-verification), [reader](library/read-content.md#open-questions-and-verification).

### B-02: Follow-up failure destroys the typed text and every selection chip

- **Where the user meets it:** The bottom follow-up bar after a completed answer.
- **What happens / what was expected:** Text and chips clear before server acceptance. If create fails, the optimistic exchange rolls back but the composed draft is gone. Recoverable user input should be retained/restored with an error.
- **Reproduce:** Queue two selection chips and text, block the create-reply request, then submit.
- **Why (from the code):** `web/src/lib/components/follow-up-bar.svelte:19-27` clears its input immediately; `web/src/lib/session.svelte.ts:235-241` clears chips before `#runExchange`; `web/src/lib/session.svelte.ts:222-227` rolls back only the exchange.
- **Severity:** `high`. It loses deliberate user work on an ordinary transient failure.
- **Decision needed:** `fix`. Clear only after acceptance or restore the full structured draft in the catch path and show the error.
- **Raised by:** [follow-up](research/follow-up.md#open-questions-and-verification), [research model](foundations/research-session-model.md#open-questions-and-verification).

### B-03: The first successful save-as-source is reported as a technical error

- **Where the user meets it:** **save as source** beside a completed exchange.
- **What happens / what was expected:** The server commits the source and compile intent but returns `title: null`; browser validation requires a string and shows a red Zod message. A successful mutation must report success with a usable fallback.
- **Reproduce:** Save a never-promoted owner exchange, observe the error, then verify the new `raw/sessions/…` source and retry after reload.
- **Why (from the code):** `packages/server/src/sessions.ts:687-713` returns null title on fresh owner/proposal paths; `web/src/lib/api/sessions.ts:196-218` requires `z.string()`; `web/src/lib/components/promote-button.svelte:21-34` turns decode failure into permanent local error state.
- **Severity:** `high`. It reverses the truth of a durable write and invites duplicate retries.
- **Decision needed:** `fix`. Accept the nullable contract and render neutral success when no title exists, or always return a genuine display title server-side.
- **Status:** `fixed` by Great Minds commits `e57a25d` and `b7548c2`, without a new regression test. `PROMOTE-04` first confirmed the defect against `c8c9e57`: the click showed **Invalid input: expected string, received null** while the source and compile intent persisted. Manual verification against `b7548c2` then showed neutral **saved as source** success on both the first save and a post-reload repeat; the nullable source remained singular and the repeat created no additional compile intent.
- **Raised by:** [save answer](research/save-an-answer-as-a-source.md#open-questions-and-verification).

### B-04: An editor can promote another creator's private session answer

- **Where the user meets it:** The session-exchange promotion endpoint, reachable if an editor knows session/exchange ids.
- **What happens / what was expected:** Read/append correctly return not found to other members, but promotion loads vault storage without checking session creator. An editor can stage a pending shared proposal containing the private answer; owner approval can then publish it as a source.
- **Reproduce:** As editor, confirm another member's session cannot be loaded; call its promote route with controlled ids; inspect the pending proposal and staged body.
- **Why (from the code):** `packages/server/src/sessions.ts:634-640` uses `requireSessionOwner` for append, while `packages/server/src/sessions.ts:643-673` promotion calls `requireEditor` then `loadAllEvents` without that check.
- **Severity:** `high`. It discloses private session content into a shared contribution workflow and puts publication one approval away.
- **Decision needed:** `fix`. Require session ownership before existing-destination checks or event reads.
- **Status:** `fixed` by Great Minds commit `476ed75`, without a new regression test. `PROMOTE-08` first confirmed the defect against `c8c9e57`: the editor's session page showed **Couldn't load this session**, but a controlled browser request returned 201 `proposed` and staged the exact private answer. Manual verification against `476ed75` returned 404 **Session not found** and created no proposal.
- **Raised by:** [save answer](research/save-an-answer-as-a-source.md#open-questions-and-verification).

### B-05: Viewer/editor membership permits shared mutations, provider work, and cancellation

- **Where the user meets it:** Health **update now**, URL ingest, reference **add to vault**, and run cancellation.
- **What happens / what was expected:** Membership alone permits direct URL/reference source writes, manual compile/provider spend, and cancellation. This conflicts with owner-only file ingest and the stated editor/proposal contribution model.
- **Reproduce:** As viewer, start a URL job, promote a personal reference, start Health update, then cancel the run.
- **Why (from the code):** `packages/server/src/ingest.ts:427-448` and `550-595` use `requireMember`; `packages/server/src/jobs.ts:175-212` uses `requireMember` for compile/cancel; `web/src/lib/components/health-content.svelte:56-72` has no role branch.
- **Severity:** `high`. It permits shared mutation, spend, and destructive cancellation by the least-privileged role.
- **Decision needed:** `resolved`. Owners may mutate shared sources, start compile, or cancel runs; editors contribute through proposal flows; viewers are read-only.
- **Status:** `fixed` by Great Minds commit `45ac124`, without a new regression test. Against `c8c9e57`, `URL-08` and `MANAGE-12` confirmed viewer source writes, a controlled viewer cancel returned 204 and cancelled a pending run, and dirty Health exposed **update now** before the absent provider key returned 503. Against `45ac124`, viewer mutation controls were absent, direct URL/reference/compile/cancel requests returned 403 without changing durable state, editor compile also returned 403, and owner controls and cancellation still worked.
- **Raised by:** [access](foundations/access-and-vault-context.md#open-questions-and-verification), [background work](foundations/background-work.md#open-questions-and-verification), [URL ingest](sources/add-a-url.md#open-questions-and-verification), [compile](sources/compile-the-vault.md#open-questions-and-verification), [manage](library/manage-content.md#open-questions-and-verification), [Health](health/review-vault-health.md#open-questions-and-verification).

### B-06: A failed Health request reports the wiki as healthy

- **Where the user meets it:** `/health` and Home/Library attention badges during network, permission, server, or decode failure.
- **What happens / what was expected:** Missing query data falls back to zero/empty arrays, so Health says **Nothing needs attention** and badges disappear. Failure should be explicit and never assert health.
- **Reproduce:** Block `/lint` with no cache and open all three surfaces.
- **Why (from the code):** `web/src/lib/hooks/use-health.svelte.ts:14-54` exposes loading but no error and defaults absent data to empty; `web/src/lib/components/health-content.svelte:44-53` maps empty arrays to healthy copy.
- **Severity:** `high`. It turns unknown into a false safety signal.
- **Decision needed:** `fix`. Add error/retry/stale timestamp states and keep the badge unknown rather than zero.
- **Raised by:** [Health](health/review-vault-health.md#open-questions-and-verification), [content model](foundations/content-model.md#open-questions-and-verification).

### B-07: Different URL sources with the same path stem overwrite one another

- **Where the user meets it:** Pasting URLs from different hosts/paths that end in the same filename (or root URLs).
- **What happens / what was expected:** Destination uses only the submitted pathname stem, so unrelated content silently upserts one `raw/docs/{stem}.md`. It should detect collision or derive a host/path-stable identity.
- **Reproduce:** Ingest two different bodies at `https://a.example/x/article` and `https://b.example/y/article?version=2`.
- **Why (from the code):** `packages/server/src/ingest.ts:310-326` derives `posix.parse(parsed.pathname).name`, writes one slug path, and calls upsert without URL collision handling.
- **Severity:** `high`. It silently destroys/replaces shared source content.
- **Decision needed:** `fix`. Use normalized URL identity and stable collision suffix or return conflict before write.
- **Raised by:** [URL ingest](sources/add-a-url.md#open-questions-and-verification).

### B-08: Direct file ingest discards folders and overwrites same-base files

- **Where the user meets it:** A dropped directory containing same-named files, or files with different extensions but the same base.
- **What happens / what was expected:** Review shows relative paths, but the handoff sends only `File`; server slugifies basename, so later files overwrite the same source. The review must not imply preserved identity while discarding it.
- **Reproduce:** Upload `a/report.txt` and `b/report.md` with different bodies in default local mode.
- **Why (from the code):** Relative paths are collected in `web/src/lib/components/ingestion-flow.svelte:302-317`, but `web/src/lib/components/pipeline-container.svelte:108-121` calls `uploadFile(file)` without destination; `packages/server/src/ingest.ts:232-241` derives basename-only destination.
- **Severity:** `high`. A confirmed multi-file batch silently loses one file's content.
- **Decision needed:** `fix`. Preserve safe relative path or detect/resolve collisions visibly before confirmation.
- **Raised by:** [add files](sources/add-files.md#open-questions-and-verification).

### B-09: File review and staged ingest can silently omit files counted as selected

- **Where the user meets it:** Mixed unrecognized/hash-error/partial R2 batches.
- **What happens / what was expected:** Selected count includes rows that confirmation filters out; partial staged PUT/conversion failures are carried internally but not rendered when some files continue. The owner can see successful completion with fewer sources than selected.
- **Reproduce:** Confirm an unrecognized-only row; then run two-file staged batches with one failed PUT and one failed conversion.
- **Why (from the code):** `web/src/lib/components/ingestion-flow.svelte:73` counts all selected but `346-350` requires hash/nonerror; labels use that count at `593-597`. `web/src/lib/api/ingest.ts:224-272` emits `failed_uploads`, which `web/src/lib/components/pipeline-container.svelte:130-160` ignores. `packages/server/src/staged-file-ingest-workflow.ts:140-220` can compile when `ingested > 0` despite failures.
- **Severity:** `high`. It silently drops user-selected source material.
- **Decision needed:** `fix`. Make eligibility/count identical and render a durable per-file outcome before claiming completion.
- **Raised by:** [add files](sources/add-files.md#open-questions-and-verification), [background work](foundations/background-work.md#open-questions-and-verification).

### B-10: A failed reply with partial prose looks successfully completed

- **Where the user meets it:** Main or BTW reply whose provider emits text before terminal failure.
- **What happens / what was expected:** Nonempty answer branch wins and hides stored error; cursor disappears/follow-up returns, making partial prose indistinguishable from success. It should retain prose with an explicit interrupted status.
- **Reproduce:** Use a provider fixture that emits one paragraph then error for main and BTW turns.
- **Why (from the code):** `web/src/lib/components/session-thread.svelte:147-166` and `web/src/lib/components/btw-thread.svelte:146-168` render interruption only when answer is empty; `packages/server/src/replies.ts:239-258, 486-495` persists error and partial answer.
- **Severity:** `high`. Users can trust incomplete/failed research as final.
- **Decision needed:** `fix`. Render terminal status independently of answer presence and prevent promotion/share ambiguity.
- **Raised by:** [session model](foundations/research-session-model.md#open-questions-and-verification), [streaming](research/streamed-answer-and-evidence.md#open-questions-and-verification), [BTW](research/btw-threads.md#open-questions-and-verification).

### B-11: A queued cancelled/failed run can display Knowledge base updated

- **Where the user meets it:** Cancelling/failing a pending run before any backend phase is assigned.
- **What happens / what was expected:** Terminal snapshot with empty phase is discarded as unknown; subsequent SSE `done` sets `overallDone`, showing success. Terminal status must be handled before phase normalization.
- **Reproduce:** Open a pending `current_phase=''` run, cancel before dispatch, wait for stream close.
- **Why (from the code):** `web/src/lib/hooks/use-job-sse.svelte.ts:271-289` sets success on `done` but calls `normalizeEvent` and returns at `282` before inspecting `job_status` for unknown/empty phases.
- **Severity:** `high`. It reports cancelled/failed work as successful publication.
- **Decision needed:** `fix`. Process terminal job status first and make `done` close-only rather than success-authoritative.
- **Raised by:** [compile](sources/compile-the-vault.md#open-questions-and-verification), [background work](foundations/background-work.md#the-simple-case).

### B-12: URL launch cannot reconnect, reloads duplicate work, and Retry does not retry the URL

- **Where the user meets it:** `/pipeline?url=…` before synchronous fetch/conversion returns or after it errors.
- **What happens / what was expected:** Server run already exists but client does not know id; reload creates a new id/fetch, leaving can late-navigate, and error Retry starts manual compile instead of refetching. The run id should be returned first and retry should repeat the failed task.
- **Reproduce:** Submit a delayed/failing URL, reload or navigate before response, inspect runs/request count, then click Retry.
- **Why (from the code):** `web/src/lib/api/jobs.ts:51-60` mints id inside `startUrlJob`; `web/src/lib/components/pipeline-container.svelte:100-188` has an unguarded async launch and learns id only after await; `198-200` Retry always calls `requestCompile`.
- **Severity:** `high`. It duplicates remote writes/runs and presents a recovery action that does something else.
- **Decision needed:** `fix`. Make URL fetch durable background work with immediate id; guard unmount and give URL-specific retry/reconnect.
- **Raised by:** [URL ingest](sources/add-a-url.md#open-questions-and-verification), [background work](foundations/background-work.md#open-questions-and-verification).

### B-13: A share silently expands to future private session turns or reference notes

- **Where the user meets it:** Creating a session/reference public link, then continuing private work.
- **What happens / what was expected:** Every recipient load reads current sidecar/reference notes, so future follow-ups, BTWs, source labels, renames, and cross-vault anchored notes appear without another share confirmation. Dialog does not say “live” or preview contents.
- **Reproduce:** Share after first turn/note, add sensitive future turns/notes, reload recipient with same token.
- **Why (from the code):** `packages/server/src/shares.ts:229-291` resolves target content and annotations dynamically; `84-126` loads all matching personal-scope sessions across vaults. `web/src/lib/components/share-dialog.svelte:151-268` describes only “anyone with this link can read it.”
- **Severity:** `high`. A public capability silently broadens after creation.
- **Decision needed:** `product call`. Explicitly choose live vs frozen; preview/redact and require consent for future expansion, or snapshot at creation.
- **Raised by:** [share/export](cross-cutting/share-and-export.md#open-questions-and-verification).

### B-14: Share requests can create unseen or multiple active bearer links

- **Where the user meets it:** Closing the modal while Create is pending or creating concurrently in two tabs.
- **What happens / what was expected:** Cancel/Done stays enabled and does not abort; a link may be created unseen. Sequential lookup is not protected by subject uniqueness, so races can mint multiple valid active tokens while dialog surfaces only one.
- **Reproduce:** Delay and close a create; separately race two creates and resolve/list both tokens.
- **Why (from the code):** `web/src/lib/components/share-dialog.svelte:127-132, 251-268` resets without cancellation and leaves Cancel enabled. `packages/server/src/shares.ts:159-205` does select-then-insert; `packages/database/src/schema.ts:526-545` has uniqueness only on token, not active creator/subject.
- **Severity:** `high`. Owners can unknowingly leave public access they cannot fully manage/revoke.
- **Decision needed:** `fix`. Disable/abort/guard modal actions and enforce active-subject uniqueness transactionally.
- **Raised by:** [share/export](cross-cutting/share-and-export.md#open-questions-and-verification).

### B-15: Public share bearer tokens are stored in plaintext

- **Where the user meets it:** Not directly visible; it determines blast radius of database/log exposure for every public link.
- **What happens / what was expected:** Exact bearer token is stored and queried directly. Since only equality lookup is needed, a hash should normally be stored like refresh tokens.
- **Reproduce:** Create a disposable share and compare URL token to database row.
- **Why (from the code):** `packages/database/src/schema.ts:526-545` stores `shares.token` text; `packages/server/src/shares.ts:62-68` queries it directly. The same schema hashes refresh tokens at `80-95`, showing an established safer pattern.
- **Severity:** `high`. Database disclosure immediately grants unauthenticated access to all active shared content.
- **Decision needed:** `fix`. Store keyed/cryptographic token hash, return plaintext only at mint time, and migrate/rotate existing links.
- **Raised by:** [share/export](cross-cutting/share-and-export.md#open-questions-and-verification).

### B-16: Another-tab vault switch can retarget an in-progress multi-file operation

- **Where the user meets it:** Multi-request direct/R2 upload while another tab changes the shared `vault_id`.
- **What happens / what was expected:** Every API helper re-reads global localStorage, so later files/process/compile can target a different vault from the reviewed label/first requests. A batch must pin one authorized vault id.
- **Reproduce:** Start a slow batch in A, switch to B in a second tab after first request, inspect both vaults and the run.
- **Why (from the code):** `web/src/lib/hooks/use-vault.svelte.ts:16-30` reacts to storage events; `web/src/lib/api/client.ts:96-100` resolves `vaultPath` per call; `web/src/lib/components/pipeline-container.svelte:108-121` performs multiple calls without captured vault id.
- **Severity:** `high`. It can write private source files to the wrong shared vault.
- **Decision needed:** `fix`. Capture vault id in confirmed handoff and pass it explicitly through every request; abort if active context changes.
- **Raised by:** [add files](sources/add-files.md#open-questions-and-verification), [access](foundations/access-and-vault-context.md#open-questions-and-verification).

## Medium

### B-17: Initial question creation errors have no visible explanation

- **Where the user meets it:** First question/provider missing, forbidden, network, or server error before acceptance.
- **What happens / what was expected:** Optimistic exchange disappears and phase returns idle; only console logs explain it. The retained input may permit retry, but the user cannot know whether anything was accepted.
- **Reproduce:** Block/fail create-reply before pending write.
- **Why (from the code):** `web/src/lib/session.svelte.ts:222-227` filters the exchange, logs, and sets idle with no error state rendered by Home.
- **Severity:** `medium`. Recoverable, but trust and duplicate-retry behavior are poor.
- **Decision needed:** `fix`. Preserve question and show acceptance-specific inline error/uncertain state.
- **Raised by:** [session model](foundations/research-session-model.md#open-questions-and-verification), [ask](research/ask-a-question.md#open-questions-and-verification).

### B-18: BTW first-turn failure loses text and leaves a malformed local thread

- **Where the user meets it:** First BTW question when create-reply fails before acceptance.
- **What happens / what was expected:** Input clears, optimistic empty-answer turn remains interrupted and cannot be dismissed; continuing can carry/persist that empty local turn. Draft should restore or cleanly retry.
- **Reproduce:** Block first BTW create, then continue before reload.
- **Why (from the code):** `web/src/lib/components/btw-thread.svelte:69-75` clears input immediately; `web/src/lib/session.svelte.ts:286-366` appends optimistic turn and catch only sets `streaming:false`; `dismissBtw` at `371-380` removes only zero-turn threads.
- **Severity:** `medium`. It loses text and strands the user in a confusing but reload-recoverable state.
- **Decision needed:** `fix`. Restore text/remove unaccepted turn and expose error/retry.
- **Raised by:** [BTW](research/btw-threads.md#open-questions-and-verification).

### B-19: Two BTW threads with the same quote collide after reload

- **Where the user meets it:** Selecting identical text in two blocks of one answer.
- **What happens / what was expected:** Threads are distinct locally by block offset but replay/export keeps newest by exchange id + quote. Logical identity must include block offset/thread id.
- **Reproduce:** Save both threads and reload/export.
- **Why (from the code):** `web/src/lib/hooks/use-saved-session.svelte.ts:16-39` and `packages/server/src/sessions.ts:214-225` key latest BTW as `${exId}\0${quote}` while later IDs include block offset.
- **Severity:** `medium`. It silently loses one durable side conversation in an uncommon repeated-text case.
- **Decision needed:** `fix`. Persist stable BTW id or include offset in dedupe key with migration compatibility.
- **Raised by:** [BTW](research/btw-threads.md#open-questions-and-verification).

### B-20: Long main answers and follow-ups have no follow-to-latest behavior

- **Where the user meets it:** A follow-up appended below a long thread or answer streaming beyond viewport.
- **What happens / what was expected:** No scroll-to-new-turn, follow-bottom, or jump-latest logic exists; work continues below view.
- **Reproduce:** Stay near top of a long session while submitting/streaming a follow-up.
- **Why (from the code):** `web/src/lib/components/session-thread.svelte:89-168` renders an overflow thread but has no append/token scroll effect or latest affordance.
- **Severity:** `medium`. The task appears stalled and requires manual discovery.
- **Decision needed:** `product call`. Add bounded auto-follow when user is near bottom plus a nonintrusive Jump to latest when not.
- **Raised by:** [streaming](research/streamed-answer-and-evidence.md#open-questions-and-verification), [follow-up](research/follow-up.md#open-questions-and-verification).

### B-21: Reader and evidence-panel failures are mislabeled as Not found

- **Where the user meets it:** Full reader or side panel under forbidden, invalid, transient network, range, schema, or server failure.
- **What happens / what was expected:** Every main failure renders **Document not found.** and every panel error renders **Not found.**, hiding retryable/access/internal distinctions.
- **Reproduce:** Force 403, 400, 500/offline, malformed payload, and true 404.
- **Why (from the code):** `web/src/lib/api/doc.ts:119-125` throws generic not-found errors; `web/src/lib/components/article-reader.svelte:274-313` ignores `documentQuery.error`; `web/src/lib/components/article-panel.svelte:128-133` treats null content after query error as Not found.
- **Severity:** `medium`. It sends users down the wrong recovery path and masks defects.
- **Decision needed:** `fix`. Preserve typed status and render access/offline/retry/internal/not-found states separately.
- **Raised by:** [navigation](foundations/navigation-and-page-state.md#open-questions-and-verification), [streaming](research/streamed-answer-and-evidence.md#open-questions-and-verification), [reader](library/read-content.md#open-questions-and-verification).

### B-22: Library request failures and invalid type state render empty or blank

- **Where the user meets it:** Article/source/facet/load-more failure or `/library?type=bogus`.
- **What happens / what was expected:** Query errors are not exposed; zero data maps to no-items/no-match. Invalid type is treated as source type while loaded articles suppress the shared empty branch, producing a blank shelf.
- **Reproduce:** Fail each list endpoint with empty cache; separately open invalid type in a vault with articles.
- **Why (from the code):** `web/src/lib/hooks/use-library.svelte.ts:61-112, 219-272` exposes loading/data but no list errors; `web/src/lib/components/vault-library-shelf.svelte:93-205` branches only on loading/items/type; unknown type derivation is at `32-40`.
- **Severity:** `medium`. Failure looks like valid absence, and malformed links can strand the page.
- **Decision needed:** `fix`. Normalize type and render query-specific error/retry states, retaining prior pages where safe.
- **Raised by:** [Library](library/browse-search-and-filter.md#open-questions-and-verification).

### B-23: Pending document notes do not reconnect and appear interrupted

- **Where the user meets it:** Reloading a reader while an accepted anchored note reply is running.
- **What happens / what was expected:** By-origin replay sets every turn nonstreaming and never tails reply id, so empty pending turn renders interrupted. It should reconnect like the session route or link clearly to still-running session.
- **Reproduce:** Pause a note before first answer, reload reader, then open session route.
- **Why (from the code):** `web/src/lib/btw.svelte.ts:52-81` preserves `replyId` but hard-codes `streaming:false`; no resume pass follows. `web/src/lib/session.svelte.ts:137-151` contains the missing resume behavior for normal sessions.
- **Severity:** `medium`. It gives false terminal status for durable work.
- **Decision needed:** `fix`. Tail pending reply ids in DocThreads or render/open-session running state.
- **Raised by:** [reader](library/read-content.md#open-questions-and-verification).

### B-24: An unresolvable document note can become inaccessible

- **Where the user meets it:** Saved note whose block/quote no longer maps into rendered Markdown.
- **What happens / what was expected:** Header removes Jump, inline card stays closed with no clickable mark, and fallback margin dot is deliberately noninteractive; note has no Open Session fallback.
- **Reproduce:** Alter body/parser result after saving note so quote or block misses, then reload.
- **Why (from the code):** `web/src/lib/components/doc-header.svelte:310-339` attaches click only when jumpable; `web/src/lib/components/footnote-notes.svelte:238-258` renders an aria-hidden pure dot; `web/src/lib/components/answer-block.svelte:117-145, 443-455` hides closed inline cards without mark access.
- **Severity:** `medium`. Durable user work remains counted but unreachable from its owning surface.
- **Decision needed:** `fix`. Always provide Open Session; offer non-destructive re-anchor/fallback context.
- **Raised by:** [reader](library/read-content.md#open-questions-and-verification).

### B-25: Full-reader metadata drops article tags and omits null-title fallbacks

- **Where the user meets it:** Full wiki reader and null-title source/reference reader.
- **What happens / what was expected:** Tagged articles have no tag chips, and null titles render blank H1 even though Library/chrome derive a name.
- **Reproduce:** Open a tagged article and null-title source/reference from Library.
- **Why (from the code):** `web/src/lib/api/doc.ts:38-49` wiki schema omits backend tags and `79-90` forces empty tags; `web/src/lib/components/doc-header.svelte:55-57, 207-218` renders raw nullable title while `article-reader.svelte:60` computes fallback only for chrome.
- **Severity:** `medium`. Reader disagrees with filtering/inventory and can have no visible title.
- **Decision needed:** `fix`. Align schema and use one shared display-title fallback.
- **Raised by:** [content model](foundations/content-model.md#open-questions-and-verification), [reader](library/read-content.md#open-questions-and-verification).

### B-26: File review recognizes formats that the active converter rejects

- **Where the user meets it:** Default local upload of PDF/office/data/extensionless files; R2 upload of old Office/EPUB/RTF; R2-capable ODP/ODS.
- **What happens / what was expected:** Review says unique/ingestable based on a format set unrelated to active converter; server fails after confirmation, while ODP/ODS cannot get hashed despite backend support.
- **Reproduce:** Test the mismatched extensions in local and R2 modes.
- **Why (from the code):** UI set is `web/src/lib/components/ingestion-flow.svelte:12-35`; direct accepts only text/HTML at `packages/server/src/ingest.ts:198-229`; staged sets differ at `packages/server/src/conversion.ts:41-64`.
- **Severity:** `medium`. A common file appears accepted then fails after the user commits.
- **Decision needed:** `fix`. Advertise/validate the exact backend capability set before confirmation.
- **Raised by:** [add files](sources/add-files.md#open-questions-and-verification).

### B-27: Direct-upload duplicate detection is both racy and ineffective on repeats

- **Where the user meets it:** Confirming immediately after hashing or selecting a file previously uploaded in local mode.
- **What happens / what was expected:** Confirm enables while remote duplicate check is pending; direct ingestion never stores the browser hash, so future preflight cannot find it.
- **Reproduce:** Delay check-dupes and click immediately; then reselect exact bytes after a successful direct upload.
- **Why (from the code):** `web/src/lib/components/ingestion-flow.svelte:275-281, 593-597` has no remote-check state. Direct `sourceDocuments.index` calls `sourceRow` without client hash (`packages/server/src/source-documents.ts:158-175`), while only staged `batchIndex` supplies it at `176-188`.
- **Severity:** `medium`. Duplicate protection is advertised but unreliable.
- **Decision needed:** `fix`. Track remote-check pending and send/verify raw hash on direct server boundary.
- **Raised by:** [add files](sources/add-files.md#open-questions-and-verification).

### B-28: Client file upload has no real cancel/recovery and can navigate after leaving

- **Where the user meets it:** Pre-run direct/R2 client transfer, especially after one file fails.
- **What happens / what was expected:** No job id/Cancel exists; effect has no abort/unmount guard; leaving can continue and late-route. Error Retry starts compile rather than resending failed/remaining files.
- **Reproduce:** Start a delayed batch, navigate Home, then inject a middle-file failure and click Retry.
- **Why (from the code):** `web/src/lib/components/pipeline-container.svelte:100-188` starts unguarded async loops without cleanup signal; Cancel requires `jobId` at `194-196`; Retry at `198-200` always compiles.
- **Severity:** `medium`. Recovery wording is false and page navigation can override user intent.
- **Decision needed:** `fix`. Abort/guard client work, persist recoverable manifest, and implement file-specific retry.
- **Raised by:** [add files](sources/add-files.md#open-questions-and-verification).

### B-29: Bare pipeline says No active job when several runs are active

- **Where the user meets it:** Home active-pipeline link or direct `/pipeline` under unexpected concurrency.
- **What happens / what was expected:** Resolver handles exactly one; zero and >1 both show no job. It should choose deterministically or list active runs.
- **Reproduce:** Seed two active runs and open bare route.
- **Why (from the code):** `web/src/lib/components/pipeline-container.svelte:174-186` checks `items.length === 1`, otherwise sets `noJobFound`.
- **Severity:** `medium`. It blocks recovery precisely when multiple work items need attention.
- **Decision needed:** `fix`. Add chooser/list or deterministic newest redirect with explicit count.
- **Raised by:** [navigation](foundations/navigation-and-page-state.md#open-questions-and-verification), [background work](foundations/background-work.md#open-questions-and-verification), [compile](sources/compile-the-vault.md#open-questions-and-verification).

### B-30: Pipeline cancel/retry/stream errors lack truthful pending and failure state

- **Where the user meets it:** Clicking Cancel/Retry/Run again or encountering non-success stream-open response.
- **What happens / what was expected:** Controls have no local pending/catch, allowing repeats and invisible rejection. Stream-opening HTTP error is presented through run failure surface even if durable run continues.
- **Reproduce:** Delay/reject each action; force transient 500 only on SSE endpoint.
- **Why (from the code):** `web/src/lib/components/pipeline-container.svelte:194-200, 287-320` has no state/try-catch; `web/src/lib/hooks/use-job-sse.svelte.ts:315-329` makes non-OK terminal `overallError` while transport exceptions retry.
- **Severity:** `medium`. Users cannot distinguish failed control/observer from failed durable work.
- **Decision needed:** `fix`. Add pending/error/idempotent controls and separate observation errors with reconnect action.
- **Raised by:** [compile](sources/compile-the-vault.md#open-questions-and-verification).

### B-31: Source deletion leaves compiled articles stale without queuing repair

- **Where the user meets it:** Confirming **delete source** or approving deletion request.
- **What happens / what was expected:** Search/source/idea graph disappears, but no compile intent is created; existing articles/citations remain until the owner separately finds a way to compile. Dialog warns vaguely about a future compile but does not offer one.
- **Reproduce:** Delete a source cited by a live article and inspect intents/article/link.
- **Why (from the code):** `packages/server/src/source-documents.ts:218-253` deletes graph/storage only; `packages/server/src/sources.ts:134-144` returns without intent. Proposal deletion branch at `packages/server/src/proposals.ts:322-327` likewise omits `ensureCompileIntent` used only for additions at `338`.
- **Severity:** `medium`. Shared published knowledge knowingly points at missing source with no direct repair handoff.
- **Decision needed:** `product call`. Queue compile automatically or provide explicit Update now action/health issue.
- **Raised by:** [manage](library/manage-content.md#open-questions-and-verification).

### B-32: Source deletion can commit database removal and then report storage failure

- **Where the user meets it:** Storage error during owner deletion.
- **What happens / what was expected:** Database transaction commits first; file delete then defects. UI says generic failure and does not refresh failure path, so stale row may remain while registry is gone and orphan file remains.
- **Reproduce:** Force storage delete failure after DB transaction.
- **Why (from the code):** `packages/server/src/source-documents.ts:218-253` completes transaction before `storage.deletePath`; `web/src/lib/hooks/use-library.svelte.ts:187-200` refreshes only success and replaces detail with generic API error.
- **Severity:** `medium`. Outcome is partially committed and reported inaccurately.
- **Decision needed:** `fix`. Make deletion convergent/retryable, expose partial state, and always refetch after uncertain outcome.
- **Raised by:** [manage](library/manage-content.md#open-questions-and-verification).

### B-33: Reference promotion drops the chosen title, author, and publication date

- **Where the user meets it:** **add to {vault}** after opening/renaming a personal reference.
- **What happens / what was expected:** Exact stored Markdown contains URL/origin/body only; user-document title/author/published live in DB and are not transferred, so fresh shared source loses explicit metadata until model enrichment.
- **Reproduce:** Rename a reference with author/date, promote, pause compile, inspect source header/row.
- **Why (from the code):** `packages/server/src/user-documents.ts:145-190` stores metadata separately; `packages/server/src/ingest.ts:427-448` copies `reference.content` unchanged and never maps row metadata.
- **Severity:** `medium`. Deliberately curated metadata vanishes at a core scope transition.
- **Decision needed:** `fix`. Merge personal metadata into source frontmatter/registry with provenance and preserve explicit rename.
- **Raised by:** [manage](library/manage-content.md#open-questions-and-verification).

### B-34: Reference rename has stale-null and overlapping-request races

- **Where the user meets it:** Clearing a title, reopening rename before refetch, or pressing Enter repeatedly on a slow request.
- **What happens / what was expected:** Null local override displays blank but draft/comparison uses old prop via nullish coalescing; no pending lock serializes PATCH responses; caches are not updated/invalidated.
- **Reproduce:** Clear title then reopen; delay two renames and release out of order.
- **Why (from the code):** `web/src/lib/components/doc-header.svelte:51-56, 104, 117-132` initializes from `document.title` and compares `titleOverride ?? document.title`; it has no pending state. Rename calls API directly without query-cache update.
- **Severity:** `medium`. The editor can show/send stale values and end with UI/DB disagreement.
- **Decision needed:** `fix`. Model explicit null distinctly, disable/serialize save, update caches, and add visible Save/Cancel.
- **Raised by:** [manage](library/manage-content.md#open-questions-and-verification), [reader](library/read-content.md#open-questions-and-verification).

### B-35: Personal references cannot be deleted in the authenticated web UI

- **Where the user meets it:** Reading room row/reference header.
- **What happens / what was expected:** Server supports creator-scoped delete but browser exposes no method/control, leaving no way to remove personal saved material.
- **Reproduce:** Inspect all reference row/header actions with keyboard and mouse.
- **Why (from the code):** Server route exists at `packages/domain/src/index.ts:1376-1383` / `packages/server/src/server.ts:368-375`; `web/src/lib/api/references.ts` exports list/create/promote/rename only and reader/header has no delete action.
- **Severity:** `medium`. User-owned retained content cannot be managed from the product surface.
- **Decision needed:** `product call`. Add deletion with consequences for notes/shares/copies, or explicitly remove/decline capability.
- **Raised by:** [manage](library/manage-content.md#open-questions-and-verification), [content model](foundations/content-model.md#open-questions-and-verification).

### B-36: Health counts and actions do not identify or reliably refresh affected content

- **Where the user meets it:** Attention badge and dirty/orphan/missing sections.
- **What happens / what was expected:** Badge sums issue rows without dedupe; dirty topic IDs are called articles but never listed/joined; orphan/missing-only states offer no Update; relevant mutations do not explicitly invalidate Health.
- **Reproduce:** Seed one article contributing multiple issues, a dirty no-article topic, and orphan-only state; then compile/delete in another tab.
- **Why (from the code):** `web/src/routes/(app)/health/+page.svelte:25-33` and Library/Home sum arrays; `web/src/lib/components/health-content.svelte:50-85` shows count/update only for dirty; `packages/server/src/lint.ts:57-70` returns topic IDs without article join; `use-health.svelte.ts:20-28` invalidates active-job, not health, on compile creation.
- **Severity:** `medium`. “Needs attention” cannot be mapped reliably to repairable objects and stays stale.
- **Decision needed:** `product call`. Define unique issue model, list targets, add remediation/refresh/timestamp.
- **Raised by:** [Health](health/review-vault-health.md#open-questions-and-verification).

### B-37: Sharing, printing, and exporting a running session produce divergent incomplete artifacts

- **Where the user meets it:** Share/Download controls while reply is pending or partially failed.
- **What happens / what was expected:** All controls are enabled after session id; live share uses durable sidecar, Markdown uses current sidecar, print uses client DOM. Evidence/BTW/origin/partial errors differ, with no warning or snapshot boundary.
- **Reproduce:** Share/export/print mid-stream and after partial failure; compare outputs before/after completion and BTW collapse.
- **Why (from the code):** Controls render in `web/src/lib/components/home-content.svelte:194-256`; print hides Thinking at `session-thread.svelte:129-144` and depends on DOM; `packages/server/src/sessions.ts:214-260` builds different Markdown; `web/src/lib/session-markdown.ts:13-25` has no terminal check.
- **Severity:** `medium`. The owner cannot know which incomplete/private content was exported.
- **Decision needed:** `fix`. Warn/block pending export or create one explicit immutable export snapshot with documented inclusions.
- **Raised by:** [share/export](cross-cutting/share-and-export.md#open-questions-and-verification).

### B-38: Share management has no expiry/central inventory and annotation scope is broad

- **Where the user meets it:** Per-subject Share dialog for references/sessions.
- **What happens / what was expected:** UI offers no expiry, central active/revoked link inventory, access audit, or existing annotation-setting edit. “Your notes” includes anchored sessions from every vault, and session shares can later fail if creator loses membership.
- **Reproduce:** Create annotated notes in two vaults, share from one, inspect dialog and recipient; then remove session creator membership.
- **Why (from the code):** `web/src/lib/components/share-dialog.svelte:199-225` hides checkbox once active and has no expiry; `web/src/lib/api/shares.ts:76-82` input omits expiry; `packages/server/src/shares.ts:84-126` queries annotations without vault filter; session resolution at `242-260` rechecks membership via SessionsService.
- **Severity:** `medium`. Bearer-link lifecycle/scope is difficult to understand and control.
- **Decision needed:** `product call`. Define annotation/vault scope, expiry, access audit, central management, and membership semantics.
- **Raised by:** [share/export](cross-cutting/share-and-export.md#open-questions-and-verification).

### B-39: Stale active-vault state has no global recovery and can reinterpret open routes

- **Where the user meets it:** Stored vault deleted/membership removed, or another tab switches while this tab is on document/session/run/health.
- **What happens / what was expected:** Global id changes in place; current route is not forced Home and missing/inaccessible active id is not replaced by another membership. Pages fail, mask errors, or load same path from different vault.
- **Reproduce:** Keep route in A, switch/delete A from second tab, then interact/reload.
- **Why (from the code):** `web/src/lib/hooks/use-vault.svelte.ts:16-30` blindly syncs storage; `web/src/lib/api/client.ts:96-100` uses current id; route components key queries but have no global invalid-vault recovery/redirect.
- **Severity:** `medium`. The user can be stranded or view an unexpected same-path object.
- **Decision needed:** `product call`. Force Home and require explicit switch, or pin vault in route/operation and provide deterministic fallback.
- **Raised by:** [access](foundations/access-and-vault-context.md#open-questions-and-verification), [navigation](foundations/navigation-and-page-state.md#open-questions-and-verification), [Library](library/browse-search-and-filter.md#open-questions-and-verification), [reader](library/read-content.md#open-questions-and-verification).

### B-40: Sign-in stores valid tokens before a failed vault load and then reports failure

- **Where the user meets it:** Successful auth verification followed by vault-list/network failure.
- **What happens / what was expected:** Tokens are stored before default-vault resolution; catch reports sign-in failure but does not clear tokens, so reload can already be authenticated.
- **Reproduce:** Intercept only post-auth vault list with 500, then unblock/reload.
- **Why (from the code):** `web/src/lib/api/client.ts:143-150` calls `storeTokens` before `resolveDefaultVault` and throws without rollback.
- **Severity:** `medium`. Success boundary/copy and resulting account state contradict each other.
- **Decision needed:** `fix`. Separate signed-in success from vault-load recovery or roll back explicitly; never say sign-in failed when it succeeded.
- **Raised by:** [access](foundations/access-and-vault-context.md#open-questions-and-verification).

### B-41: Save-as-source success state is local and disappears on reload

- **Where the user meets it:** Returning to an exchange already promoted.
- **What happens / what was expected:** Component always starts idle and does not check deterministic source/proposal, so it invites redundant Save again and provides no source link.
- **Reproduce:** Promote successfully/retry, reload session.
- **Why (from the code):** `web/src/lib/components/promote-button.svelte:5-18` initializes local state only; SessionThread renders it solely from answer/session conditions at `session-thread.svelte:128-136`.
- **Severity:** `medium`. Durable mutation status is forgotten and users cannot navigate to result.
- **Decision needed:** `fix`. Return/include promotion state in session read or query deterministic destination and render durable link/status.
- **Raised by:** [save answer](research/save-an-answer-as-a-source.md#open-questions-and-verification).

### B-42: URL ingest exposes the full URL in history and mislabels later-stage failures

- **Where the user meets it:** `/pipeline?url=…` containing query credentials, or conversion/storage failure after successful fetch.
- **What happens / what was expected:** Entire encoded URL stays in browser history until success; every source-ingest failure is attached to Fetching URL even when conversion/storage/registration failed; redirect final metadata is also lost.
- **Reproduce:** Use a dummy token query and force conversion/storage failures after 200 response.
- **Why (from the code):** `web/src/lib/components/ingestion-flow.svelte:323-326` writes full URL query. `packages/server/src/ingest.ts:554-593` marks all catch causes on `fetch_url`; `310-326` continues using submitted URL/path after redirects.
- **Severity:** `medium`. Sensitive data can persist locally and error recovery points to the wrong stage.
- **Decision needed:** `fix`. Pass launch state/body rather than URL query, preserve submitted/final URL distinctly, and report true failing step.
- **Raised by:** [URL ingest](sources/add-a-url.md#open-questions-and-verification).

### B-43: Compile completion truncates or hides results and overstates no-op status

- **Where the user meets it:** Successful completion with >8 articles, result-query failure, or zero newly rendered articles but other changes.
- **What happens / what was expected:** Total can exceed the eight fetched links with no indication; result error is silent; zero is labeled **nothing changed** despite indexing/archive/topic work.
- **Reproduce:** Create all three completion fixtures.
- **Why (from the code):** `web/src/lib/api/wiki.ts:39-47` defaults limit 8; `web/src/lib/components/pipeline-container.svelte:357-390` renders only `result.data`, no error/loading/overflow explanation, and maps total zero directly to no-change copy.
- **Severity:** `medium`. Completion summary can be materially false/incomplete.
- **Decision needed:** `fix`. Describe render delta accurately, expose query failure and omitted count/load-more.
- **Raised by:** [compile](sources/compile-the-vault.md#open-questions-and-verification).

### B-44: Historical evidence resolves live source paths rather than answer-time content

- **Where the user meets it:** Opening an old source card after source mutation/deletion.
- **What happens / what was expected:** Reply stores path/ranges/full only; panel reads current storage/search rows, so old evidence can show changed content or disappear. Historical reproducibility is undefined.
- **Reproduce:** Complete sourced answer, modify/delete source, reopen card.
- **Why (from the code):** Reply source shape is built in `packages/server/src/replies.ts:91-153` without content hash/excerpt; `web/src/lib/panel-content.ts:20-47` fetches current document/chunks by path.
- **Severity:** `medium`. Evidence may no longer support the archived answer.
- **Decision needed:** `product call`. Store hashes/excerpts/snapshots or explicitly label live current content and preserve answer-time citation material elsewhere.
- **Raised by:** [streaming](research/streamed-answer-and-evidence.md#open-questions-and-verification).

### B-45: Durable research generation has no Stop action

- **Where the user meets it:** Long/expensive main or BTW reply after acceptance.
- **What happens / what was expected:** Escape/navigation only stop observation; no cancel endpoint/control exists. Users cannot halt unwanted provider work.
- **Reproduce:** Start a long reply and inspect/leave/reopen.
- **Why (from the code):** `web/src/lib/session.svelte.ts` has abort controllers only for client tails/destruction and no server cancel method; `session-thread.svelte` exposes no Stop; RepliesService has create/stream/recovery but no cancel operation (`packages/server/src/replies.ts:155-168`).
- **Severity:** `medium`. Work/cost continues but leaving is a viable workaround for observation only.
- **Decision needed:** `product call`. Confirm leave-to-finish as intentional or add durable cooperative cancellation/status.
- **Raised by:** [session model](foundations/research-session-model.md#open-questions-and-verification), [ask](research/ask-a-question.md#open-questions-and-verification).

### B-46: Dynamic progress and selection actions lack robust assistive semantics

- **Where the user meets it:** Streaming answer/evidence, pipeline stages, fixed selection popovers, clickable highlighted marks, result/status text.
- **What happens / what was expected:** No explicit live/status regions announce updates; selection action only runs on top-level mouse-up; `<mark>` toggles have no button/focus semantics; smooth auto-scroll ignores reduced-motion branch.
- **Reproduce:** Run research/pipeline and create/select notes using keyboard + screen reader + Reduced Motion.
- **Why (from the code):** `web/src/lib/components/answer-block.svelte:348-365, 390-440` receives `MouseEvent` selection; mark click is delegated at `225-240`; no `aria-live`/status appears in session/pipeline/promote components; pipeline auto-scroll is in `pipeline-container.svelte:77-86`.
- **Severity:** `medium`. Core research actions/status may be unavailable or silent to assistive users.
- **Decision needed:** `fix`. Add keyboard selection/action path, semantic controls/focus restoration, intentional live regions, and reduced-motion behavior.
- **Raised by:** [session model](foundations/research-session-model.md#open-questions-and-verification), [streaming](research/streamed-answer-and-evidence.md#open-questions-and-verification), [follow-up](research/follow-up.md#open-questions-and-verification), [BTW](research/btw-threads.md#open-questions-and-verification), [reader](library/read-content.md#open-questions-and-verification), [compile](sources/compile-the-vault.md#open-questions-and-verification).

## Low

### B-47: Library count, wildcard, tag, and synthesis-pin semantics are misleading

- **Where the user meets it:** Search/type/tag/Reading room chip counts and tagged results.
- **What happens / what was expected:** Source facets/All ignore search, header mixes scopes, `%`/`_` act as SQL wildcards, tagged Reading room says empty, and exact synthesis pin depends on fetched pages.
- **Reproduce:** Use controlled metadata/search, `%`/`_`, active tag with references, and >50 matching articles.
- **Why (from the code):** `packages/server/src/sources.ts:68-82, 111-125` constructs unescaped patterns and search-agnostic facets; `web/src/lib/hooks/use-library.svelte.ts:135-153, 244-272` computes differing totals/page-local pin; `library-content.svelte:75-98` forces tagged references empty and `reading-room-shelf.svelte:55-67` uses generic empty copy.
- **Severity:** `low`. Results remain recoverable but labels/counts can confuse.
- **Decision needed:** `product call`. Define literal/wildcard search, count scopes, tagged-reference copy, and pin query semantics.
- **Raised by:** [Library](library/browse-search-and-filter.md#open-questions-and-verification), [content model](foundations/content-model.md#open-questions-and-verification).

### B-48: Clipboard and Markdown-export failures have no visible error

- **Where the user meets it:** Copy Share link with denied permission or export Markdown during network/download failure.
- **What happens / what was expected:** Promise rejection is unhandled; no pending/error/retry appears.
- **Reproduce:** Deny clipboard; block session Markdown endpoint.
- **Why (from the code):** `web/src/lib/components/share-dialog.svelte:117-122` awaits clipboard without catch; `web/src/lib/session-markdown.ts:13-25` throws through a void call in `home-content.svelte:245-253` with no state.
- **Severity:** `low`. The action fails recoverably but silently.
- **Decision needed:** `fix`. Add pending/success/error states and fallback selectable link/download retry.
- **Raised by:** [share/export](cross-cutting/share-and-export.md#open-questions-and-verification).

### B-49: Pipeline pages omit the run context needed to identify work

- **Where the user meets it:** Direct/copied `/pipeline/runs/{id}`, especially with several queued runs.
- **What happens / what was expected:** Page shows stages but no vault name, trigger, id, start/elapsed time, or cost/ETA; URL is the only identity.
- **Reproduce:** Open two run URLs from different triggers/vault contexts and compare header.
- **Why (from the code):** `web/src/lib/components/pipeline-container.svelte:203-401` header/body renders Home/Cancel/stages/results but no fields already present in `Job` (`web/src/lib/api/jobs.ts:15-31`).
- **Severity:** `low`. Work remains controllable but hard to distinguish.
- **Decision needed:** `product call`. Add at least vault, trigger, created/elapsed, run id copy, and clarify whether cost/ETA are reliable.
- **Raised by:** [compile](sources/compile-the-vault.md#open-questions-and-verification).

### B-50: Small discovery/copy inconsistencies obscure notes and filtered content

- **Where the user meets it:** First selection tip, compact BTW evidence, and Reading room under tag.
- **What happens / what was expected:** Reader/session share one global hint flag, so dismissing one suppresses the other; compact article evidence looks like main evidence but cannot open; tagged Reading room says personally empty rather than “references have no tags.”
- **Reproduce:** Clear/dismiss each hint in turn, click BTW badges, and select Reading room under a tag.
- **Why (from the code):** Both `article-reader.svelte:36-37, 156-157` and `session-thread.svelte:44-54` use `onboarding-hint-seen`; `btw-thread.svelte:115-143` renders `ArticleBadge` without `onClick`; `library-content.svelte:75-98` supplies no items and `reading-room-shelf.svelte:55-67` chooses generic empty text.
- **Severity:** `low`. No durable data is lost, but affordance/copy consistency suffers.
- **Decision needed:** `fix`. Separate hint keys/context, make evidence styling/interaction honest, and use tag-specific empty copy.
- **Raised by:** [reader](library/read-content.md#edge-cases), [BTW](research/btw-threads.md#open-questions-and-verification), [Library](library/browse-search-and-filter.md#open-questions-and-verification).
