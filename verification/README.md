# Hand verification

The feature documents were written from Great Minds source and tests. This directory is the protocol for checking them against the running product, one observable claim at a time.

## What is here

| File | Covers |
| --- | --- |
| [foundations-and-reading-room.md](foundations-and-reading-room.md) | `foundations/*` and `reading-room/open-an-external-article.md` |
| [research.md](research.md) | `research/*` |
| [sources-and-library.md](sources-and-library.md) | `sources/*`, `library/*`, and `health/*` |
| [sharing-and-export.md](sharing-and-export.md) | `cross-cutting/share-and-export.md` |

Each file has one table per document. Each row has a stable ID, priority, required device/condition, linked claim, exact setup, numbered steps, expected result, and Result. Result remains `—` until a tester records `pass`, `fail`, or `blocked` plus a short note.

Priorities: **P1** is a load-bearing claim or suspected defect; **P2** is an ordinary claim; **P3** is timing, count, layout, or another fine detail.

## How to run a pass

1. Use the isolated [verification environment](environment/README.md). From `verification/environment`, run `node manage.mjs reset` and `node prepare-browsers.mjs`. This creates a separate database/storage root, populated owner vault, alternate vault, role accounts, deterministic external URLs, and saved browser profiles without touching the ordinary Great Minds database. Provider-backed research/compile rows remain blocked until a usable `OPENROUTER_API_KEY` is supplied through ignored `.env.local`; R2 rows require a separate disposable R2 deployment.
2. Confirm the source commit before every pass: `git -C /Users/kijana/Documents/Code/great_minds rev-parse --short HEAD` must be `c8c9e57`. The harness also refuses startup on source drift or tracked source changes. If the check fails, record the pass as blocked unless the whole description is intentionally repinned.
3. Keep the linked document beside the browser. Run P1 across all files first, then P2, then P3.
4. Use real browser interaction for the input under test. Developer tools, SQL, storage inspection, and server logs may establish setup or verify durable state, but synthetic events are not evidence for focus, selection, drag, animation, or accessibility behavior.
5. Record `pass`, `fail`, or `blocked` in place. For anything except a clean pass, append a concise condition/result note.
6. Map each failed item to [`bug-triage.md`](../bug-triage.md). Add the checklist ID to an existing entry's Status, or create an entry if the document—not the product—was wrong and say so.
7. A document changes from `drafted` to `verified` only after every P1 and P2 row has passed or been filed with a resolved Status. Automated checks alone never make it verified.

Do not use a real personal vault for destructive, sharing, malformed-file, cross-role, offline, or race tests. Some items intentionally create public bearer links, delete sources, start paid provider work, or race tabs.

## Devices and conditions

- **mouse:** Desktop browser with a fine pointer at 1440×900 unless setup says otherwise.
- **keyboard:** Same browser, completing the interaction without a pointer; use Tab/Shift+Tab and native selection keys.
- **narrow:** Resize below 768 px for full-width overlays; use 900–1199 px for the 370 px overlay and ≥1200 px for docking/margin-footnote checks.
- **screen reader:** VoiceOver on macOS/Safari or NVDA/Firefox; record browser/reader versions.
- **second tab:** Same browser profile/account. Local-storage vault changes propagate; this is not a different user.
- **second member:** Separate browser profile with editor or viewer membership as named. Never substitute a second tab.
- **offline:** Browser developer-tools Offline after the stated request boundary. To test an in-flight stream disconnect, use request blocking/network throttling rather than only starting offline.
- **server control:** Ability to stop/restart the API/worker, remove an object, inject a deterministic provider failure, inspect database/storage, or use a local fixture HTTP server.
- **R2:** A disposable R2-backed deployment with CORS configured. Default local mode cannot exercise staged PUT/conversion behavior.
- **print:** Browser with Save as PDF. Record browser/version and inspect the generated file, not only print preview.
- **clipboard denied:** Deny clipboard permission before choosing Copy.

## Driving the product from a console or script

Use SQL/storage/test fixture helpers to create exact dirty topics, archived articles, same-name files, pending replies, multiple active runs, and second-role accounts. Use browser network interception for dropped create responses, stream disconnects, delayed responses, and specific HTTP failures. Use a local HTTP fixture for URL content type, redirects, timeouts, and oversized bodies.

The console can inspect route, focus, local storage, DOM IDs/marks, and durable API responses after a real gesture. It cannot stand in for native drag/drop, directory picker cancellation, text selection popovers, screen-reader announcement, print pagination, focus restoration, or background-tab timing.

Provider prose is nondeterministic. Assertions should concern accepted/pending/terminal state, evidence structure, persistence, and visible failure—not exact answer wording.

## Results so far

Hand verification has started. `ACCESS-01` passed: sign-in and the selected alternate vault survived reload. `PROMOTE-04` passed and confirmed B-03 against the pinned `c8c9e57` baseline; Great Minds commits `e57a25d` and `b7548c2` later fixed it. `PROMOTE-08` passed and confirmed B-04; commit `476ed75` later fixed it. `URL-08` and `MANAGE-12` passed and confirmed B-05's viewer mutations; `ACCESS-11`, `PIPE-08`, `COMPILE-10`, and `HEALTH-08` are partial because the absent provider key blocked manual compile creation, although viewer cancellation was confirmed. Commit `45ac124` later enforced the resolved owner/editor/viewer policy and was manually checked. `HEALTH-04` passed and confirmed B-06's false-healthy failure; commit `817d93f` later replaced it with shared unavailable/retry state and was manually checked through recovery. `URL-05` passed and confirmed B-07's same-stem URL overwrite; commit `b588057` later replaced path identity with stable source IDs and was manually checked for coexistence and idempotent refresh. `FILES-08` retains no baseline Result, but a post-`b588057` hand check showed two same-stem direct uploads persisting as distinct sources; `e500c9d` adds regression coverage. The listed rows retain the historical baseline observations; all other Result cells remain `—`, and no feature document is marked `verified`. Source reading, integration tests, link checking, structural checks, and environment smoke checks do not count as visible-product verification.
