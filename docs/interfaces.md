# Command line and MCP

The HTTP API is defined in `packages/domain`. The CLI uses its generated client; the server-hosted MCP adapter calls the same authorized application services. Neither owns a separate search, document reader or publication implementation.

## Reading

| Capability | CLI | MCP |
| --- | --- | --- |
| Vaults | `gm vaults`, `gm vault use <name-or-id>` | `list_vaults` |
| Passage search | `gm search <query> [--path <document>]` | `search_vault` |
| Whole document | `gm read <path>` | `read_document` |
| Indexed passages | `gm chunks <path> --start <index> --end <index>` | `read_chunks` |
| Article links | `gm links <path>` | `read_links` |
| Article browsing | `gm articles` | `list_articles` |
| Source metadata queries | `gm sources` | `query_sources` |
| Conversations | `gm sessions`, `gm session <id> [--json]` | `list_sessions`, `read_session` |
| PDF/Markdown files | `gm export <id> --output <file>` | `read_session` with `format` |

CLI reading commands accept `--vault` and `--json`; the vault defaults to the saved choice, `GM_VAULT`, or the only available vault. `--json` returns the API representation. Search and chunk results are arrays; MCP wraps those arrays in `hits` and `chunks` respectively to provide an object-root output schema. Document reads and list responses otherwise reuse the API schemas, including metadata and pagination. Conversation formats are described in [Conversations](conversations.md#api-cli-and-mcp).

Article browsing supports `contains`, `tag`, `run` (Update id), and `sort` (`title`, `linked`, `recent`). Use the corresponding `--` flags in the CLI. Recent ordering uses the recent-articles API and cannot be combined with filters; incompatible requests fail rather than silently ignoring filters. Source queries support tags, author, genre, date bounds and the vault's own metadata fields.

CLI article, source, session and run lists accept `--limit` and `--offset`; the default limit is 20. Human output shows how to request the next page; JSON includes `pagination`. `gm vaults` already reads all accessible vault pages. MCP vault, article and session lists accept numeric `limit` and `offset`, defaulting to 50 and 0, and return the API's `items`/`pagination` envelope. A zero limit on those MCP lists returns counts without items; metadata source queries require a positive limit. These reading lists can be traversed beyond their first page.

Chunk indices are inclusive and refer to the indexed document, not source line numbers. The common service clamps negative starts and limits each request to 100 chunks. Links include outgoing, incoming and related live wiki articles. Search may use the server's embedding model and requires a sponsored account, even though it does not change content; ordinary reads do not call models.

## Updates and uploads

| Capability | CLI | MCP |
| --- | --- | --- |
| List jobs | `gm runs [--status active]` | `list_jobs` |
| Current job status | `gm run <id> --once [--json]` | `read_job` |
| Follow a job | `gm run <id>` | Read job snapshots as needed |
| Start an Update | `gm update` | `start_update` |
| Cancel a job | `gm cancel <id>` | `cancel_job` |
| Retry a URL import | `gm retry <id> [--job-id <new-uuid>]` | `retry_url_job` |

Job lists share the domain's status filters and pagination. MCP start/retry operations return the accepted job immediately rather than holding a tool call open until the work finishes. CLI update/retry commands reuse the existing progress stream. Cancellation requests do not assert that work was cancelled: completed/missing jobs are unchanged. MCP returns the requested `job_id`; use `read_job` for its state.

Only failed/cancelled URL imports have a retry operation. A retry has a new UUID (`next_job_id` in MCP); reuse that UUID if repeating the same retry after losing its response. The CLI generates and prints one before submitting unless `--job-id` supplies it. File uploads retain their existing batch recovery, while `start_update`/`gm update` start new work and must not be blindly repeated after an uncertain response. Starting/retrying paid work requires sponsorship; cancellation does not. All three require vault ownership and the key's change permission.

## Conversation controls

| Capability | CLI | MCP |
| --- | --- | --- |
| Stop a reply | `gm reply stop <reply-id>` | `stop_reply` |
| Retry a failed reply | `gm reply retry <reply-id> [--reply-id <new-uuid>]` | `retry_reply` |
| Continue a saved side note | `gm continue-session <session-id>` | `continue_session` |
| Add a saved answer to a vault | `gm promote-answer <session-id> <exchange-id>` | `promote_answer` |

`gm ask` and reply retries print accepted reply/session IDs to stderr before following the answer. JSON stdout remains the final reply snapshot. Stop receipts acknowledge a request, not a stopped outcome; a settled reply is unchanged. Retrying is only for failed replies, not stopped replies or disconnected streams. The CLI prints the replacement UUID before submission; MCP requires `next_reply_id`. After a lost acceptance response, repeat the same predecessor/replacement pair. The CLI follows the existing reply stream; MCP returns accepted identities immediately, with progress available through `read_session`.

Continue preserves the conversation ID and history, changing placement and the mode of future replies without generating an answer. Promotion copies a completed/stopped nonempty answer verbatim with citations and origin: owners ingest, editors propose. Inspect the returned `mode` before claiming publication. Repeats reuse an existing source or pending proposal. Get exchange IDs from `exId` in `gm session <id> --json` or `read_session`. All actions retain private-conversation ownership; retry and promotion require sponsorship, while stop and continue do not.

## Ingestion and personal references

| Capability | CLI | MCP |
| --- | --- | --- |
| Local files/folders | `gm add <paths...>` | Use the CLI/API upload lifecycle |
| Import a URL into a vault | `gm add-url <url> [--job-id <uuid>]` | `ingest_url` |
| Import Markdown directly | `gm ingest <file> --dest raw/docs/name.md` | `ingest_text` |
| Personal reference list | `gm references` | `list_references` |
| Save/read a personal reference | `gm reference save <url>`, `gm reference read <refs/path.md>` | `save_reference`, `read_reference` |
| Rename/delete a reference | `gm reference rename <id> <title>`, `gm reference delete <id>` | `rename_reference`, `delete_reference` |
| Add a reference to a vault | `gm reference promote <refs/path.md>` | `promote_reference` |

Personal references belong to the signed-in account, not a selected vault. Saving one fetches its public URL but does not start an Update; repeat saves reuse the existing reference. Renaming changes only its title (empty CLI title / MCP null clears it). Deletion has no undo and does not remove copies already promoted into vaults. Promotion requires vault ownership and sponsorship and reuses an existing promoted copy. All adapters retain the API's existing personal-reference permissions.

URL imports use a caller-chosen `job_id` in MCP; the CLI generates and prints it unless supplied. Reuse it only for the same URL/origin request after a lost response. Markdown imports create a new source on every call and return its identity/path, with normal server metadata and paragraph anchors; do not blindly retry them. Neither transport gains access to private-network URLs. MCP does not read file paths on the caller's computer; use `gm add` for local files.

## Sources and proposals

| Capability | CLI | MCP |
| --- | --- | --- |
| Read by source identity | `gm source read <id>` | `read_source` |
| Delete a source | `gm source delete <id>` | `delete_source` |
| Request source deletion | `gm source request-deletion <id>` | `request_source_deletion` |
| List proposals | `gm proposals [--status pending]` | `list_proposals` |
| Read proposal metadata/status | `gm proposal read <id>` | `read_proposal` |
| Propose Markdown | `gm proposal create <file> [--title ...] [--author ...] [--content-type ...]` | `create_proposal` |
| Review a proposal | `gm proposal review <id> <decision>` | `review_proposal` |
| Submit a correction/note | `gm suggest <file> [--anchor <document-path>] [--passage <quoted-text>]` | `submit_suggestion` |

Source IDs are available in `gm sources --json`. Owners delete sources directly; editors request deletion for owner review. Deletion retires the source but does not start an Update or remove generated articles. It has no undo.

Review decisions are `approved` or `rejected`. Repeating the same decision is safe; changing it conflicts. An approved proposal can still be `applying`, or end `not_applied`; inspect its application status before claiming the change finished. Suggestions become sources directly for owners and proposals for editors. Creating a proposal or suggestion creates new content each time; do not blindly repeat an uncertain request.

## Permissions

CLI and MCP API keys remain subject to both key scope and vault membership/role checks. Reading is not permission to ask paid questions or change content. The server distinguishes `read`, `ask`, `change`, and browser-session-only `account` operations. MCP maps tools to the canonical HTTP endpoint permission/model policies rather than keeping another policy list. A raw `gm api` call does not bypass these checks.

Sharing, membership changes, ownership transfer, vault deletion and other account-sensitive operations currently require a browser session. Do not expose them by weakening the API-key guard. Adding privileged CLI/MCP access requires an explicit authentication and authorization design.
