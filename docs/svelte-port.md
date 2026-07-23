# Svelte frontend port — living plan

Decided 2026-07-22. Hard cut: the React app in `web/` is replaced in place on
branch `svelte-port`; no coexistence, no shims. `main` stays deployable React
until the single merge. The deployed React app against the production backend
is the acceptance oracle for every phase.

## Stack

- Svelte 5 (≥ 5.25, runes) + SvelteKit 2, `adapter-static` configured to emit
  `dist/` with `index.html` fallback, `ssr = false` globally — byte-equivalent
  deploy to today (`render.yaml` untouched: `pnpm --filter web run build`,
  `staticPublishPath: web/dist`; package name stays `web`).
- shadcn-svelte (on Bits UI) for primitives: button, badge, input, collapsible,
  dropdown-menu, tooltip, separator.
- `@tanstack/svelte-query` v6 (runes-native) + devtools.
- Tailwind 4 via `@tailwindcss/vite`; the existing `index.css` theme tokens
  port verbatim. `tailwind-merge`, `clsx`, `zod`, `@fontsource-variable/*`
  unchanged. `@lucide/svelte` for icons.
- Markdown: keep the unified/remark/rehype pipeline (remark-gfm + our two
  footnote rehype plugins, unchanged); rendering via a custom recursive
  hast→Svelte component (see Query surface notes).
- Animation: Svelte built-ins only (`transition:`, `crossfade`, `animate:`).
  No motion library.
- Tooling: `svelte-check` for types (replaces `tsgo -b` in `types-web`),
  `prettier` + `prettier-plugin-svelte` for `.svelte` formatting; oxlint/oxfmt
  continue to cover plain `.ts` under `web/src/lib`. Justfile recipes updated
  at cutover.

## Porting rules

1. Framework-agnostic code moves verbatim: `api/*` (client, schemas, query
   incl. SSE parser and pending/settled pairing, sessions, doc, sources,
   explore, jobs), `lib/anchor.ts`, `lib/highlight.ts`,
   `lib/streaming-markdown.ts`, `lib/session-markdown.ts`, `lib/utils.ts`,
   `lib/chip.ts`, `lib/control-styles.ts`, the rehype plugins from
   `lib/markdown.tsx`, and `lib/types.ts`. Wire formats and persistence
   payloads must not change by a byte.
2. Do NOT transliterate React workarounds — they exist because React re-renders
   coarsely and Svelte doesn't. Dies at the border: the `stateRef` +
   `buildComponents` stable-identity machinery, `MemoMarkdown`, the
   `BtwRenderContext`/`AnchoredThreads` tunnel, `memo()` wrappers, the
   `useAnchoredBtws` equality-bailout dance. Their replacements are keyed
   `{#each}` blocks, `$derived`, and fine-grained props.
3. Hooks table: `use-session` → `session.svelte.ts` class with `$state`
   fields (same public surface: thread/phase/chips/popover + the same
   persistence calls); `use-theme` → tiny runes module or `mode-watcher`;
   `use-saved-session`/`use-sessions`/etc. → svelte-query v6; router hooks →
   `$app/navigation`/`load`.
4. Every phase ends green: `svelte-check`, build, and the phase's browser
   acceptance below. No phase merges React and Svelte code paths.

## Phases

**P0 — Scaffold** (branch `svelte-port`, `web/` replaced in place)
Kit skeleton, ssr=false, adapter output `dist/`, Tailwind 4 + tokens, fonts,
shadcn-svelte init + the seven primitives restyled to current look, dev proxy
(`/api` → backend, same as vite.config today), route stubs for all twelve
routes, auth guard layout (token store ported), login page working.
Acceptance: login round-trip against a real backend in the browser; theme
toggle correct in both modes.

**P1 — Framework-agnostic core**
`api/` + `lib/` moved verbatim; svelte-query client configured (same
staleness/retry posture as `lib/query-client.ts`).
Acceptance: svelte-check + build; a scratch page streams a real `/query` SSE
response through `consumeStream` and logs sources/tokens correctly.

**P2 — Read surfaces**
App shell + corner menu + project switcher; home (idle state incl. ingestion
flow entry), sources, wiki, explore, sessions list, pipeline (job SSE
progress), project settings, vault-new.
Acceptance: side-by-side browser walk (agent-browser) against the React app on
the same backend — every route renders the same data; pipeline progress
streams live.

**P3 — Document reader**
Doc page + loader, article view/chrome/panel, selection popover, promote
button, link interceptor, ingestion flow incl. drag-drop upload (test with a
synthetic DataTransfer drop — the event must bubble through the innermost
handler, see M4.5 notes) and R2 bulk path.
Acceptance: read an article, follow a citation deep-link to a raw source,
upload a document, start a compile from it.

**P4 — Query surface** (the hard one, last)
Search bar + morph animation (crossfade), session thread, thinking section
(chips incl. pending pulse + web/kb/doc-scoped variants), the answer renderer,
BTW threads (create/reply/dismiss/spin-off, autofocus etiquette as shipped),
follow-up bar (as shipped: column-aligned, underlined input), saved-session
replay, markdown export, print styles.

Answer renderer design (the one novel piece): parse with the existing unified
pipeline into hast; render via a recursive `<HastNode>` Svelte component with
a block-component map. Each block element carries `data-block-offset` from
`node.position.start.offset` exactly as today (anchor identity is persisted —
must not change). While streaming, parse the `splitStreamingMarkdown` stable
prefix once per completed block ($derived on the prefix string) and only
re-parse the tail; when streaming ends, one full parse — same strategy as
React, minus the memo machinery. BTW threads render inline after their
anchored block via the placement map (a `$derived` over btws + rendered
blocks); highlights via the same CSS Highlights `lib/highlight.ts`.
Acceptance: full live streamed query side-by-side with React — chips
(pending→resolved), thinking collapse, answer blocks, selection popover, BTW
create + streamed reply + collapse + reload persistence (anchors resolve),
follow-up with chips, promote, export markdown byte-identical to React's,
print. Then a saved pre-port session replays identically.

**P5 — Cutover**
Delete remaining React files, update justfile (`types-web`→svelte-check,
`format-web`→prettier check for .svelte + oxfmt for .ts), README, merge to
main (single merge commit), deploy, prod browser smoke (login → query → BTW →
upload), watch logs.
Rollback: revert the merge commit — backend untouched throughout.

## Deliberate divergences from the React oracle

The React app is the behavioral oracle for the port EXCEPT the following
user-approved design changes (2026-07-23), which are built directly in their
intended form rather than ported-then-reworked:

- **P0 follow-up — login polish**: `autocomplete="email"` + autofocus on the
  email field; `autocomplete="one-time-code"` + `inputmode="numeric"` on the
  code field (Safari/iOS autofill from Mail), auto-submit on the final digit,
  paste-tolerant. Separately (backend, post-port): raise
  `JWT_REFRESH_EXPIRY_DAYS` for long sliding sessions; passkeys are on the
  architectural backlog.
- **P2 — library consolidation**: sources and wiki merge into one library
  page — single search box, one chip row where `articles` is a facet
  alongside source types, one row anatomy, count in header, side panel on
  row click for peeking (full `/doc` navigation as the deliberate second
  step). Explore is restructured as discovery + health: recent articles
  first; the lint sections each gain their action (compile trigger for
  drift; missing-connection rows open the source article); the
  navigation-disguised-as-filters chip row is removed. The side panel
  reflows the content column beside it at ≥1200px instead of overlapping;
  below that, a subtle scrim.
- **P3 — citations open the side panel**: the article reader wires the link
  interceptor's `onDocOpen` (designed but unwired in React). Bare raw-source
  citations open the panel in doc mode; chunk-anchored citations (`#^pN`)
  open it in chunks mode showing the cited paragraph; Maximize remains the
  full-document escape.
- **P4 — footnote margin notes**: at wide viewports, footnote content (already
  resolved onto each ref as `data-footnote-content`) renders as right-margin
  notes aligned to the reference block, quiet until ref hover; at narrow
  widths and on touch, click/tap opens a popover anchored to the ref. The
  bottom footnote section remains for print/export.

## Risks / watchpoints

- Bits UI behavior differences vs Base UI on collapsible/dropdown/tooltip —
  re-verify keyboard + dismiss behavior on the BTW and corner-menu surfaces.
- svelte-query v6 is new — pin exact versions; if the adapter misbehaves, our
  query layer is thin enough to fall back to plain runes + fetch without
  changing `api/`.
- Print styles and `#session-print` export path are easy to forget — P4
  acceptance includes them.
- Branch drift: React tweaks landing on main during the port must be mirrored
  in the port branch (the recent UX/perf batch is the spec; keep main frozen
  for frontend changes where possible).
