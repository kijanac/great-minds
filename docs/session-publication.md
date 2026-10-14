# Private conversation publication

## User contract

**Export** prepares one fixed reading copy of the saved conversation and its directly attached saved BTW threads, including continued threads. Expansion state is irrelevant. A4 is the default; Letter and **Refresh copy** each prepare a fresh copy. The inline preview, **Download PDF**, and **Open PDF in a new tab** use the same generated PDF bytes. **Markdown** comes from the same preparation response, not another read.

Preparation waits for included content to finish generating and saving. The server rejects active content with `409 Conflict`; unreadable required history or an unavailable attached note prevents the whole export with `503 ServiceUnavailable`. There is no incomplete-copy option and no running/stopped/failed badge in the document. Saved stopped and failed partial prose can be exported privately. An empty completed answer is not reclassified as failure.

Questions, answers, recorded passage context, prose citations, and direct notes are included. Unsent drafts, Thinking/source-activity panels, model/system/tool messages, retained follow-up context, recursive ancestors/siblings, and linked documents are not included. Export does not generate replies, promote content, create shares, or change public-share selection or formatting.

Closing export retains the mounted conversation and its drafts/scroll state, but discards the prepared copy. Closing, leaving the component, or changing account/vault/conversation interrupts preparation and releases Blob URLs. A failed refresh does not present an older copy as a successful new preparation. Already downloaded files are ordinary private files outside the application's control.

## Architecture

```text
SessionsService.readSession (existing authorized bounded reads)
  → prepareSessionPublication (selection/readiness)
  → compilePublication (one normalized Markdown AST)
      ├─ Markdown serialization
      └─ static Typst template + JSON data → PDF
  → one response → scoped browser preview/download URLs
```

Root and child reads are separate authorized observations. The returned content is fixed for that preparation; it is not a globally atomic database/object-store snapshot. `prepared_at` records preparation time, not historical source provenance.

The compiler namespaces references per exchange, assigns unique heading destinations, preserves ordinary GFM structure, and resolves `raw/` and `wiki/` links to absolute `/doc/...` URLs with an explicit vault parameter. Those links are labelled access-required. The document route verifies membership in the requested vault before opening it and supports heading and recorded `^pN` passage destinations. Export never mints a public link to make a private citation accessible.

Raw HTML and Typst-looking text are literal content, not executable markup. The template reads JSON; it does not evaluate stored prose as Typst. Images remain references in Markdown and become linked alt text in PDF; the renderer does not fetch or embed remote images. HTTP, HTTPS, mailto, and resolved local heading links are supported; unsupported destinations do not become executable PDF links.

The new frontend request and resource orchestration remain Effect-based until the Svelte execution boundary. Native filesystem, process, and fetch APIs are adapters. Broader frontend Promise/Effect consistency remains a [separate review](./effect-style.md#deferred-review-frontend-effectpromise-consistency).

## Provisioning

The backend image copies **Typst 0.15.1** from:

```text
ghcr.io/typst/typst:0.15.1@sha256:032e292249bcd378480cc7c142cfa324b63ef8aadeb88d7e7230320c4c9c422f
```

The upstream `LICENSE` and `NOTICE` from the verified 0.15.1 release accompany the binary under `packages/server/assets/typst/`.

At build time, `packages/server/scripts/install-publication-fonts.ts` installs the checked manifest in `packages/server/src/publication/assets.ts`. Libre Baskerville, JetBrains Mono, and Noto Sans SC come from a pinned Google Fonts revision with SHA-256 checks and OFL licenses. DejaVu Sans/Serif 2.37 are vendored with their license under `packages/server/assets/dejavu/` and checked by the same installer; those binaries came from `fonts-dejavu-core_2.37-8build1_all.deb`. The generated font directory is ignored by Git and Docker input; local caches cannot substitute for the build's verified assets.

For local development, install Typst 0.15.1 separately. From the repository root after dependency installation:

```sh
typst --version
node --experimental-strip-types packages/server/scripts/install-publication-fonts.ts
```

Run font installation before starting the server: the installer owns and replaces the generated font directory. It needs network access for the pinned downloads; ordinary PDF rendering does not fetch fonts.

| Variable | Default | Purpose |
| --- | --- | --- |
| `TYPST_BINARY` | `typst` | Executable name or absolute path on the server. |
| `PUBLIC_WEB_URL` | `http://localhost:5173` | Browser-facing HTTP(S) base URL for private document links; set to the deployed web origin. Render configuration uses `https://greatmind.dev`. |
| `TMPDIR` | OS default | Node's temporary-directory location; use private, ephemeral storage with enough space for the selected conversation and PDF. |

Hosted users install nothing. Typst and PDF fonts are server assets, not web-bundle dependencies. A missing executable/font or compilation failure returns a safe `503`; unrelated application features and the standalone Markdown endpoint do not require a successful PDF compile. There is no renderer fallback to browser printing.

## Resource and privacy boundaries

- One compiler process per renderer instance/API process. Concurrent renders fail as busy rather than joining a queue. This gate covers rendering, not preceding authorized reads and normalization.
- One private temporary directory per accepted render, with mode-0600 input JSON. Filesystem operations finish before scoped cleanup; cancellation kills the compiler and awaits its exit before removing the directory and releasing admission.
- The compiler receives a stripped environment, an explicit project root, only provisioned fonts, and empty local package/cache directories. Stored content cannot request Typst imports or filesystem reads. Project-root restrictions are not a general OS/network sandbox.
- Compiler diagnostics are not returned or logged with private content. Ordinary completion, failure, and interruption remove temporary plaintext. A forced process/host crash can leave temporary files; ephemeral runtime storage must handle that case. No persistent export table, render queue, artifact cache, or export-history service is introduced.
- Responses use `Cache-Control: private, no-store` and `X-Content-Type-Options: nosniff`. PDF bytes are base64 in the JSON response, decoded by the typed client; this is not a direct PDF streaming endpoint.
- There is no new arbitrary content limit, compile deadline, or retry loop. Single-process fixture measurements do not establish production capacity or memory budgets.

## Supported output and known boundaries

The reading layout uses Libre Baskerville and JetBrains Mono, embedded fallback fonts, ordinary tables with repeated headers, unique citation endnotes, headings/outlines, page numbers, and A4/Letter paper. PDF/UA-1 compilation checks are enabled and reject the tested unsupported-glyph case. This is not independent PDF/UA certification or a screen-reader conformance claim.

Very wide tables and long unbroken tokens can exceed the page width. No zero-width characters, text rewriting, or PDF postprocessor are used to hide this limitation. The stress fixture is not evidence of its prevalence in real conversations. Images are linked descriptions, and mathematical extensions beyond ordinary Markdown are not interpreted. Embedded PDF viewing depends on the browser; the new-tab and download actions remain available. Narrow Chromium layout was checked, not every mobile device/PDF viewer.

## Verification and retention

Permanent regressions cover private selection/readiness, scoped citations and links, a real representative Typst compile and missing-glyph rejection, child-process cancellation/cleanup/busy release, authenticated HTTP export and disconnect cancellation, unchanged public sharing, client fetch interruption, shared preview/download URLs, and document heading/passage IDs. The broader conversation regressions remain in their existing suites.

```sh
TYPST_BINARY=typst pnpm test:history-settlement \
  packages/server/test/read-endpoints.integration.test.ts \
  packages/server/test/shares.integration.test.ts \
  packages/server/test/publication.test.ts \
  packages/server/test/pdf-lifecycle.test.ts \
  packages/server/test/sessions.test.ts
pnpm --filter web exec vitest run src/lib/api/runtime.test.ts \
  src/lib/conversation-status.test.ts src/lib/block-refs.test.ts \
  src/lib/btw.test.ts src/lib/reply-turn.test.ts src/lib/anchor-marks.test.ts
```

The server command provisions its own purpose-marked disposable database; do not substitute an ambient production database. Font installation and Typst are prerequisites for the actual-render test.

Disposable evidence is kept separately under `/tmp/gm-publication-implementation-fG0Qek/`: actual SvelteKit routes with controlled HTTP data and real rendering, downloaded-byte equality, closed-note inclusion, draft preservation, refresh/paper changes, close/navigation cancellation, Blob cleanup on vault change and logout, source-vault navigation, and desktop/narrow screenshots. The packaged renderer also ran as UID 999 with a read-only filesystem and network disabled. Its A4 output matched native bytes; A4 and Letter inspection retained all 48 required markers across 10 pages, verified citation/heading destinations, embedded fonts, metadata, tags, and normal content bounds. These are synthetic checks, not production-data or universal accessibility/capacity claims. Neither this proof harness nor the earlier feasibility corpus is promoted wholesale into the permanent suite.

API details are in [API.md](../API.md). The [original proposal](./future-ideas/session-publication-and-export-rewrite-proposal.md) retains historical investigations and staging rationale. Production migration and deployment remain separately authorized work.
