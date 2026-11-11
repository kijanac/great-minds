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

## Permissions

CLI and MCP API keys remain subject to both key scope and vault membership/role checks. Reading is not permission to ask paid questions or change content. The server distinguishes `read`, `ask`, `change`, and browser-session-only `account` operations. MCP maps tools to the canonical HTTP endpoint permission/model policies rather than keeping another policy list. A raw `gm api` call does not bypass these checks.

Sharing, membership changes, ownership transfer, vault deletion and other account-sensitive operations currently require a browser session. Do not expose them by weakening the API-key guard. Adding privileged CLI/MCP access requires an explicit authentication and authorization design.
