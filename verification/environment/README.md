# Disposable verification environment

This harness runs the Great Minds owner surface at source commit `c8c9e57` without touching the repository's ordinary `great_minds` database or storage. It is intended only for the hand-verification checklists in the parent directory.

## Safety boundary

- PostgreSQL runs in Compose project `gm_product_verification` on `127.0.0.1:55435` with its own named volume.
- API storage, logs, process IDs, tokens, fixture manifest, and saved browser states live under ignored `.state/`.
- The API runs with `SUPPRESS_AUTH=true`, a disposable JWT secret, local storage, and private-URL fetch enabled. Never expose it beyond localhost or reuse it as production configuration.
- `reset` deletes only this harness's Compose volume and `.state/`; it does not operate on the ordinary `great_minds` Compose project.
- Startup refuses a Great Minds source checkout whose HEAD is not exactly `c8c9e57` or whose tracked files are modified.

## Start from a clean fixture

From this directory:

```sh
node manage.mjs reset
node prepare-browsers.mjs
```

`reset` starts and migrates the isolated database, API, web app, and deterministic URL fixture server, then seeds the accounts and content below. Startup finishes with a redacted smoke check of service health, role boundaries, fixture counts, readers, and Health state. `prepare-browsers.mjs` signs in four isolated `agent-browser` sessions through the visible suppressed-auth form and selects the intended vault.

Use `start` instead of `reset` to preserve the current verification database and rerun the convergent fixture seed:

```sh
node manage.mjs start
```

## Running services

| Service | Address | Notes |
| --- | --- | --- |
| Web | `http://localhost:5173` | Authenticated verification surface |
| API | `http://127.0.0.1:8000` | TypeScript API pinned to `c8c9e57` |
| PostgreSQL | `127.0.0.1:55435` | Database `gm_product_verification` |
| URL fixtures | `http://127.0.0.1:4174` | Deterministic external-fetch cases |

Check health and the redacted fixture summary with:

```sh
node manage.mjs status
```

Stop the managed processes and database while retaining state:

```sh
node manage.mjs stop
```

## Seeded identities and vaults

| Browser role | Email | Active vault |
| --- | --- | --- |
| owner | `owner.verify@example.test` | `Verification Primary` |
| editor | `editor.verify@example.test` | `Verification Primary` |
| viewer | `viewer.verify@example.test` | `Verification Primary` |
| nonmember | `nonmember.verify@example.test` | Their empty default vault |

The owner also has `Verification Alternate` for explicit vault-switch and second-tab checks. Editor and viewer are members of Primary; nonmember is not.

Prepared live browser sessions are:

- `gm-verification-owner`
- `gm-verification-editor`
- `gm-verification-viewer`
- `gm-verification-nonmember`

For example:

```sh
agent-browser --session gm-verification-owner snapshot -i -C
```

Saved browser storage states are under `.state/browser/`. The private `.state/manifest.json` contains bearer and refresh tokens as well as all generated IDs; it is mode `0600`, ignored by Git, and must not be shared.

## Seeded content

`Verification Primary` starts ready, with no compile intent or pipeline run:

- three sources: a titled/tagged book, a titled/tagged article, and a null-title document;
- two cross-linked, tagged wiki articles;
- one personal Reading room reference containing a unique `silver kingfisher` phrase;
- one two-exchange research session with raw/article evidence and a BTW thread;
- one personal-reference anchored note and one article-anchored note;
- searchable chunks for every seeded source/article.

The fixture deliberately includes unique phrases, null metadata, tags, links, origins, evidence ranges, and personal/vault anchors so ordinary browse, reader, session, evidence, scope, and fallback checks do not require provider spend.

## URL fixture cases

| Path | Behavior |
| --- | --- |
| `/article` | Stable article with title, author, date, and two paragraphs |
| `/host-a/report` and `/host-b/report` | Distinct documents with the same final path stem |
| `/redirect` | `302` to `/redirect-target` |
| `/slow?ms=4000` | Delayed successful article, capped at 30 seconds |
| `/error` | `503` response |
| `/empty` | Valid HTML with no article body |
| `/document.pdf` | Deterministic non-convertible PDF response |

The full URLs are also recorded in `.state/manifest.json`.

## Provider and R2 checks

Provider-backed research and compile checks are currently blocked unless a usable key is supplied privately. Copy `.env.example` to ignored `.env.local`, set `OPENROUTER_API_KEY`, then restart the API:

```sh
node manage.mjs stop
node manage.mjs start
node prepare-browsers.mjs
```

The default harness intentionally uses local storage. Staged R2 upload checks still require a separate disposable R2-backed deployment; do not point this harness at a real content bucket.

## What this setup proves

A successful setup proves only that the pinned app can start, authenticate disposable identities, resolve the expected role/vault scopes, and render the seeded Home, Library, reader, reference, and session surfaces. It does **not** mark any checklist row passed. Run each checklist interaction and record its visible result separately.
