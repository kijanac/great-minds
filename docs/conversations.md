# Conversations

## Authority and recovery

| Fact | Authority |
| --- | --- |
| Accepted questions, attempts, saved answers, sources, follow-up context, origin/cutoff | Versioned JSONL in `vaults/<vault_id>/sessions/<session_id>.jsonl` |
| Access, placement, future reply mode, operation status/progress, acknowledged history receipt | PostgreSQL |
| Unfinished generation | Effect workflow journal and `vaults/<vault_id>/operations/replies/<reply_id>.json` |
| Markdown and PDF | Derived publications, never a second transcript authority |

The runtime accepts only native version-1 history. Parsing requires valid UTF-8, complete newline-terminated records, valid identities and ancestry, and consecutive sequence numbers. Corrupt files are rejected rather than salvaged as apparently complete conversations. A session's sequence/SHA-256 receipt verifies the acknowledged byte prefix; missing or shortened acknowledged history is an error, not permission to recreate it.

Admission reserves the exact command, reply identity, context and effective mode before writing history. It confirms the history receipt before making generation runnable. Only one admitting/running/settling reply may exist per conversation. Repeating the same accepted command retains its identity; incompatible reuse conflicts. Continue changes placement and the default for future replies, not accepted requests or recorded provenance.

Settlement freezes one exact result in the reply row, conditionally publishes it to history, then commits the terminal projection and receipt. Reconciliation finishes unfinished admission/publication without depending on workflow liveness. Already-recorded results take precedence over stale progress or a later Stop. Storage I/O never occurs inside these DB transactions; shared transitions lock the session before its reply.

Writes use backend conditional versions. A conflicting write gets at most one fresh receipt-checked observation: an identical already-present batch is acknowledged without another write; other conflicts remain conflicts. Local storage has one scoped OS-locked writer, flushed replacement/rename, and directory synchronization. R2 uses conditional PUTs and ETags. These guarantees do not cover unfenced external writers or arbitrary filesystems.

An external model/tool call with an unresolved saved claim is not automatically replayed. It fails with an explicit interrupted/unknown outcome, retaining committed partial output. Observed stream failures likewise do not authorize fallback generation; clean EOF alone is not completion evidence. Explicit retry creates a new reply ID in the same exchange. The browser retains that retry identity across lost acknowledgments.

Readers check access, history receipts and app revisions around bounded storage reads. Root and attached-note reads are separate observations, not a globally atomic DB/object-store snapshot. Unreadable required content fails or remains explicitly unavailable; it is not silently dropped. Live progress is same-attempt DB progress, and admitting/settling activity is distinct from saved prose. Read paths do not repair history.

Saved context uses the recorded parent/cutoff, not whichever answer is latest now. Selected passage and inherited context are distinct. Immediate-parent tool results are retained; older tool results may be replaced with the existing omission marker. Public sharing and promotion remain restricted to completed/stopped answers; private failed partials do not become public content.

## Publication

The authenticated export reads the complete saved root and its direct attached notes, including closed and continued notes. Saved stopped/failed prose is included without execution badges. Active or unreadable required content blocks publication. Unsent drafts, system/model/tool messages, inherited follow-up context, recursive relatives and linked-document bodies are excluded.

One normalized Markdown tree produces paired Markdown and PDF. PDF preview and download use the same bytes. If PDF preparation fails, the user may independently prepare complete Markdown with fresh authorization and the same selection policy; it is a new observation, not a partial remainder of the failed preparation. The conversation stays mounted, and account/vault/session changes or closure cancel requests and revoke Blob URLs.

Typst is server-only, using a static data-only template and pinned compiler/fonts. It does not evaluate conversation text or fetch linked assets. Source links include the original vault and require authorization; membership enumeration is paginated. The PDF handles A4/Letter, scoped citations, headings and ordinary Markdown. Common emoji such as 💡 have a pinned fallback, not universal Unicode coverage. Unsupported text fails PDF rather than silently disappearing; extreme unbroken code/table widths may overflow. Compiler PDF/UA-1 checks are not independent accessibility certification.

Each server process permits one PDF render, rejecting contention rather than queuing it. Interruption kills the compiler and removes its private temporary directory before releasing the permit. A host crash can leave temporary plaintext: use suitable ephemeral storage. There is no export cache, persistent artifact or job service.

Production Docker builds install verified fonts and Typst 0.15.1 with their applicable upstream notices. `PUBLIC_WEB_URL` must be the public HTTP(S) app URL for document links. `TYPST_BINARY` can override the compiler path; `TMPDIR` controls temporary plaintext placement. Hosted users install nothing. See [API.md](../API.md) for endpoints, response types and error statuses.

## Development checks

Run from the workspace root:

```sh
pnpm test:history-settlement --all
pnpm --prefix web exec vitest run --config vite.config.ts
pnpm run typecheck
```

The server runner owns a UUID-named disposable PostgreSQL instance, verifies its purpose marker, and removes its containers/volumes. Never point destructive tests at an ambient database. Full mode installs pinned fonts and copies the pinned compiler from Docker on Linux; other hosts must supply Typst 0.15.1 through `TYPST_BINARY`. Focused server paths can replace `--all`. Live model smoke tests are disabled by this runner.

## Cutover boundary

Native schema startup does not convert historical files. Release requires the separately retained, reviewed migration bundle and a matching DB/object/checkpoint backup: rehearse restoration on an isolated copy, resolve inventory exceptions, fence all old writers, convert and verify, then deploy compatible API/web/workers and reopen access. Do not apply only the schema or run historical writers against native data.

The migration bundle contains one-off capture/plan/apply tools and their rehearsal, not runtime compatibility. Preserve it through the migration window. Before reopening, rollback restores matching stores and application code; after new native writes, restoring an old backup loses those writes and requires a separately reviewed recovery plan. Dumps, histories and checkpoints are sensitive plaintext.
