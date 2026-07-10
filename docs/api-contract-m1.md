# M1 API contract inventory — auth + read paths

Source of truth per `docs/ts-migration-m1.md`: the Zod schemas/fetch calls in `web/src/api/*.ts` and the FastAPI response models in `app/api/schemas/` (+ the core domain schemas they compose). Python routers are the requirements source, not the design source.

## Mount reality

- `server.py::create_app()` mounts `v1_router` (from `app/api/v1/__init__.py`) with **no additional prefix**. `v1_router = APIRouter(prefix="/v1")`.
- Non-vault-scoped routers included directly under `/v1`: `auth_routes` (prefix `/auth`), `vault_routes` (prefix `/vaults`), `cost_routes` (out of scope).
- Vault-scoped routers are nested under `/v1/vaults/{vault_id}/`, with `Depends(require_vault_member)` applied **once at this router level** (so every vault-scoped route requires vault membership, even where a specific route doesn't re-declare a guard): `wiki_routes` (no own prefix — routes are literally `/wiki`, `/raw/sources`, `/doc/{path}`, `/chunks`, `/links`), `session_routes` (prefix `/sessions`), plus (out of scope) `compile_routes`, `ingest_routes`, `lint_routes`, `job_routes`, `query_routes`, `proposal_routes`, vault-scoped `cost_routes`.
- Effective full paths: `/v1/auth/...`, `/v1/vaults`, `/v1/vaults/{vault_id}`, `/v1/vaults/{vault_id}/wiki`, `/v1/vaults/{vault_id}/doc/{path}`, `/v1/vaults/{vault_id}/sessions`, etc.
- **Frontend prepends `VITE_API_BASE`** (`web/src/api/client.ts::apiFetch`), default `"/api"` in dev (proxied), but `render.yaml` sets prod's `VITE_API_BASE = https://great-minds-api.onrender.com/v1`. So in the deployed app, `API_BASE` already includes `/v1` — frontend calls `apiFetch("/vaults")`, `vaultPath("/wiki")` etc. **without** an explicit `/v1` segment; the prefix comes entirely from the env var. A TS reimplementation must mount its router at whatever path `VITE_API_BASE` is pointed at during smoke testing — the `/v1` segment is not hardcoded in the frontend, only in the env config.
- Auth: `HTTPBearer` (`Authorization: Bearer <token>`) required on every in-scope endpoint except `POST /auth/request-code` and `POST /auth/verify-code` and `POST /auth/refresh` (pre-auth by definition). `get_current_user` tries JWT decode first, then falls back to API-key lookup (`gm_...` raw keys, SHA-256 hashed at rest) — either credential type authenticates any endpoint using `CurrentUser`. No scope/permission difference between JWT and API-key auth in M1's read surface.

---

## Service meta (`server.py:209-216`, defined directly on the app — outside `/v1`)

Trivially in-scope: any TS server replacing the Python one needs these for deploy-platform health probes (Render pings them).

### GET `/health`

| | |
|---|---|
| Auth | none |
| Response | `200`, `{"status": "ok"}` |

### GET `/` and HEAD `/`

| | |
|---|---|
| Auth | none |
| Response | `200`, `{"status": "ok"}` (empty body for HEAD, per HTTP semantics) |
| Note | Both methods registered on the same handler via stacked decorators. These live at the app root, **not** under `/v1` — they are unaffected by the mount-prefix discussion above. |

---

## Auth (`app/api/auth_routes.py`)

Base path: `/auth` (mounted directly under `/v1`, not vault-scoped).

Framing note: M1 is "auth + read paths" — **auth's own write endpoints (token minting, api-key create/revoke, account delete) are in scope by design**; they are the one deliberate exception to the reads-only rule, per the parent plan's scope table.

### POST `/auth/request-code`

| | |
|---|---|
| Auth | none |
| Body | `{ email: string (EmailStr) }` |
| Response | `204 No Content`, empty body |
| Side effects | Generates a 6-digit numeric code (`f"{secrets.randbelow(1_000_000):06d}"`), invalidates any prior unused code for that email (marks `used=True`), stores SHA-256 hash with `expires_at = now + auth_code_expiry_minutes` (default 10 min), emails it via `Mailer`. If `settings.suppress_auth` is true, **no code is generated or sent at all** (silent no-op, still 204) — used for test/dev environments. Email is normalized (`normalize_email`) before lookup/storage. |
| Errors | None explicit — pydantic 422 on invalid email shape. |

### POST `/auth/verify-code`

| | |
|---|---|
| Auth | none |
| Body | `{ email: string, code: string }` |
| Response | `200`, `TokenPair` = `{ access_token: string, refresh_token: string, token_type: "bearer" }` |
| Side effects | Validates code (hash match, unused, unexpired) unless `suppress_auth` (bypasses check entirely). Marks code used. Calls `user_service.ensure_user(email)` — **creates the user row if it doesn't exist** (this is signup and login unified). Mints access JWT (HS256, `sub`=user id, `type`="access", `exp` = now + `jwt_access_expiry_minutes` default 30 min) and a random refresh token (`secrets.token_urlsafe(48)`), stores refresh token hash with `expires_at = now + jwt_refresh_expiry_days` (default 7 days). **Then calls `vault_service.ensure_default_for_user(access_token, email)`** — if the user has zero vault memberships, creates a vault named `"{email}'s vault"` and provisions R2 bucket if applicable. This is a significant side effect: first-ever login always produces a vault. |
| Errors | `401` `{"detail": "Invalid or expired code"}` if code invalid/expired/wrong (and not suppressed). |

### POST `/auth/refresh`

| | |
|---|---|
| Auth | none (bearer is the refresh token in body, not header) |
| Body | `{ refresh_token: string }` |
| Response | `200`, `TokenPair` (same shape as verify-code) |
| Side effects | Looks up refresh token by SHA-256 hash, requires `revoked=False` and `expires_at > now`. **Rotates**: marks the old refresh token row `revoked=True`, issues a brand-new access token + brand-new refresh token (stored fresh). Old refresh token is single-use — reuse after rotation fails. |
| Errors | `401` `{"detail": "Invalid or expired refresh token"}`. |
| Frontend behavior | `client.ts::apiFetch` auto-retries once on any `401` by calling this endpoint and retrying the original request with the new access token; concurrent 401s are coalesced into one in-flight refresh (`refreshInFlight` promise). |

### POST `/auth/api-keys`

| | |
|---|---|
| Auth | required (JWT or API key) |
| Body | `{ label: string }` |
| Response | `201`, `ApiKeyWithSecret` = `{ id, label, created_at, revoked, raw_key }` |
| Side effects | Generates `raw_key = "gm_" + secrets.token_urlsafe(32)`, stores SHA-256 hash. **`raw_key` is returned exactly once** — never retrievable again. |

### GET `/auth/api-keys`

| | |
|---|---|
| Auth | required |
| Response | `200`, `ApiKey[]` = `{ id, label, created_at, revoked }[]` — no `raw_key` |
| Behavior | Returns **all** keys for the user including revoked ones, newest-first (`ORDER BY created_at DESC`), so the UI can show full history. |

### DELETE `/auth/api-keys/{key_id}`

| | |
|---|---|
| Auth | required |
| Response | `204` |
| Behavior | Sets `revoked=True`. Ownership-checked: a key not owned by the caller behaves identically to a nonexistent key. |
| Errors | `404` `{"detail": "API key not found"}` if missing or not owned by caller. |

### DELETE `/auth/me`

| | |
|---|---|
| Auth | required |
| Body | `{ confirm: "DELETE" }` (Literal — any other value is a 422) |
| Response | `204` |
| Side effects | **Destructive, out-of-scope-adjacent but is auth's own write, so listed for completeness.** Deletes every vault the caller **owns** (DB rows + R2 storage), then the user row (cascades api_keys, refresh_tokens, vault_memberships), then the user's R2 bucket if using r2 backend. Vaults where the caller is only a member (not owner) are untouched; membership row cascades away. |

---

## Vaults (`app/api/vault_routes.py`) — in-scope reads only

Base path: `/vaults` (mounted directly under `/v1`, **not** under the `vault_scoped` sub-router — so these routes do their own per-route auth/role checks rather than inheriting `require_vault_member`).

M1 scope note: only the **read** endpoints below are in scope. `POST /vaults`, `POST /vaults/draft-hint`, `PATCH /vaults/{id}/config`, `POST/PUT/DELETE /vaults/{id}/members*`, `POST /vaults/{id}/transfer-ownership`, `DELETE /vaults/{id}` are writes — out of scope, documented in "explicitly out of M1 scope."

### GET `/vaults`

| | |
|---|---|
| Auth | required (any authenticated user; no vault-membership dependency — result set is naturally scoped by JOIN) |
| Query | `limit: int` (default 50, 0–200), `offset: int` (default 0) |
| Response | `200`, `VaultPage` = `{ items: Vault[], pagination: PageInfo, roles: Record<string /* vault_id */, string /* role */> }` |
| `Vault` shape | `{ id: uuid, name: string, owner_id: uuid, created_at: datetime, r2_bucket_name: string \| null }` |
| Behavior | Vaults the caller is a **member** of (any role), newest-`created_at`-first. `roles` is a redundant convenience map keyed by vault id string → role string, duplicating the per-item role that a plain `VaultWithRole` would carry (see oddities). |

### GET `/vaults/{vault_id}`

| | |
|---|---|
| Auth | required; membership checked manually inside the handler (not via `VaultMemberGuard` dependency) |
| Response | `200`, `VaultDetail` = `Vault` fields + `{ role: MemberRole ("owner" \| "editor" \| "viewer" — StrEnum, not free-form string), member_count: number, article_count: number }` |
| Behavior | `article_count` = count of rows in `wiki_articles` for the vault (includes archived rows — `WikiArticleService.count` has no `archived` filter, unlike the list/browse queries which exclude archived). |
| Errors | `404` `{"detail": "Vault not found"}` if vault id doesn't exist; `403` `{"detail": "Not a member of this vault"}` if it exists but caller isn't a member. **Note the ordering**: existence is checked before membership, so a non-member gets 403 (leaking vault existence) rather than 404. |

### GET `/vaults/{vault_id}/config`

| | |
|---|---|
| Auth | `VaultMemberGuard` (403 `"Only vault members can perform this action"` if not a member) |
| Response | `200`, `VaultConfig` = `{ thematic_hint: string, kinds: string[] }` |
| Behavior | Reads `config.yaml` from vault storage (not DB) via `load_vault_config`. Always returns a value — defaults are merged in if the vault hasn't overridden them (see `core/vaults/config.py` for the merge; not read in this pass but implied by `_init_vault_storage` always writing a default config.yaml at vault creation). |
| Errors | `404` `{"detail": "Vault not found"}` — only reachable if the vault row was deleted after the guard ran (race), since the guard already implies vault existence via membership lookup. |

### GET `/vaults/{vault_id}/members`

| | |
|---|---|
| Auth | **`VaultOwnerGuard`** — owner-only, not just member (403 `"Only vault owners can perform this action"`) |
| Query | `limit`, `offset` (same `PageParamsQuery`) |
| Response | `200`, generic `Page<MemberWithEmail>` = `{ items: { user_id: uuid, role: string, email: string }[], pagination: PageInfo }` — **no `roles` map** (unlike `VaultPage`); role is inline per-item here. |
| Behavior | Members ordered by `email` ascending (not role, not join date). |
| Errors | `404` `{"detail": "Vault not found"}` if vault missing. |

---

## Wiki + Documents + Sources (`app/api/wiki_routes.py`)

All routes below live under the vault-scoped router (`Depends(require_vault_member)` applied at the parent router — every route requires vault membership at minimum, even where not re-stated). No own path prefix — paths are literal (`/wiki`, `/wiki/recent`, `/raw/sources`, `/wiki/{slug}`, `/doc/{path}`, `/chunks`, `/links`).

### GET `/wiki` — article index

| | |
|---|---|
| Auth | vault member (inherited) |
| Query | `limit`, `offset`; `run: uuid \| null` — filters to articles rendered by that pipeline run (drives the "what this compile built" card) |
| Response | `200`, `Page<WikiArticleOverview>` |
| `WikiArticleOverview` (Python) | `{ file_path: string, title: string, precis: string, updated_at: datetime \| null, slug: string (computed from file_path) }` — **`precis` is a required non-null string** in the Python model. |
| Sort | Always `WikiSort.ALPHA` (`ORDER BY lower(title)`) for this route — case-insensitive title order, ascending. |
| Filtering | Excludes `file_path == "wiki/_index.md"` and `archived == true` unconditionally. |

### GET `/wiki/recent`

| | |
|---|---|
| Same shape as `/wiki` | |
| Sort | Always `WikiSort.RECENT` (`ORDER BY updated_at DESC`). No `run` filter param exposed on this route. |
| Note | `WikiSort` also has a `CENTRAL` mode (most-inbound-backlinks-first, tie-broken alphabetically) used internally by `browse_articles` (the query-agent tool, out of scope) — **not reachable from any in-scope HTTP route**. |

### GET `/raw/sources` — source listing/search

| | |
|---|---|
| Auth | vault member (inherited) |
| Query | `limit`, `offset`; `source_type: string \| null`; `search: string \| null` |
| Response | `200`, `FacetedPage<SourceDocumentSummary, SourceDocumentFacets>` = `{ items: [...], pagination: PageInfo, facets: { source_types: FacetCount[] } }`, `FacetCount = { value: string, count: number }` |
| `SourceDocumentSummary` | `{ file_path, source_type, title: string\|null, author: string\|null, published_date: string\|null, url: string\|null, origin: string\|null, genre: string\|null, precis: string\|null, tags: string[], derived_extras: dict, updated_at: datetime\|null }` |
| `search` semantics | `ILIKE '%search%'` against **`title` OR `author`** only — does not search `precis`, `tags`, or full text. |
| `source_type` semantics | Exact match, not partial. |
| Sort | Always `updated_at DESC`. No sort param exposed. |
| Facets | `source_types` facet is computed over **all vault sources**, ignoring the current `source_type`/`search` filters (i.e. the facet counts are not "counts within current filter" — they're global counts for building the filter UI, ungated by the query the user just made). |
| Not in this response | `id`, `body_hash`, `provenance_*`, `etag`, `client_hash`, `created_at` — those exist on the full `SourceDocument` (returned from `/doc/{path}`) but are stripped in the list summary. |

### GET `/wiki/{slug}` — article read (unstripped)

| | |
|---|---|
| Auth | vault member (inherited) |
| Path | `slug: string` |
| Response | `200`, `ArticleResponse` = `{ slug: string, content: string, archived: boolean (always false here), superseded_by: string\|null (always null here) }` |
| Behavior | Reads `wiki/{slug}.md` from storage **with frontmatter still attached** (`storage.read(..., strict=False)`, no `parse_frontmatter` call) — unlike `/doc/{path}` which strips frontmatter into a separate `body` field. `archived`/`superseded_by` are always the schema defaults (`false`/`null`) — this route has no archived-article fallback logic (see `/doc/{path}` below), so a slug whose live file was archived away 404s here even though `/doc/wiki/{slug}.md` would resolve it. |
| Errors | `404` `{"detail": "Article not found: {slug}"}` |
| **Frontend usage** | **No caller found anywhere in `web/src`.** Appears dead/unused by the current React app (see oddities). |

### GET `/doc/{path}` — document content read (the one the frontend actually uses)

| | |
|---|---|
| Auth | vault member (inherited) |
| Path | `path: string` — must match `wiki/<slug>.md` or `raw/<kind>/<rest...>.md`; validated by `_safe_document_read_path` (rejects backslashes, `..`, absolute paths, non-`.md` suffix, and paths that aren't at least 2 segments under `wiki/` or 3 under `raw/`) |
| Response | `200`, `DocResponse` = `{ article: SourceDocument \| WikiArticle (discriminated by "kind"), body: string, archived: boolean, superseded_by: string\|null }` |
| `SourceDocument` (kind="source") | `{ kind, id, vault_id, file_path, body_hash, source_type, etag, url, origin, provenance_session_id, provenance_exchange_id, provenance_session_query, provenance_source_doc_path, provenance_source_anchor, provenance_source_paragraph_index, provenance_anchored_to, provenance_anchored_section, provenance_intent, title, precis, author, published_date, genre, tags, derived_extras, created_at, updated_at }` — LLM-derived fields null until first compile, with a precision: only `title`/`precis`/`author`/`published_date`/`genre` are truly Optional (`null`); `tags` defaults to `[]` and `derived_extras` to `{}` — never null. |
| `WikiArticle` (kind="wiki") | `{ kind, id, vault_id, topic_id, file_path, body_hash, title, precis, tags, created_at, updated_at, slug (computed) }` — `title`/`precis` required non-null (snapshot at render time). |
| `body` | Frontmatter-stripped markdown body (via `parse_frontmatter`). |
| Behavior — archived fallback | If `path` starts with `wiki/` and the live file is gone (404 on disk) — because a recompile archived the topic — falls back to `_read_archived_wiki`: resolves `slug → topic → article_status == ARCHIVED`, reads the article from its **archived** `file_path` (moved under `archive/` by validate), and returns `archived: true`, `superseded_by: <successor slug>` (looked up via `topic.superseded_by → Topic.slug`, or `null` if no successor). If the topic isn't archived (or doesn't exist), falls through to a normal 404. **This fallback only applies to `wiki/` paths — `raw/` paths have no equivalent recovery.** |
| Behavior — registry mismatch | If the file exists on disk but has no matching DB row (`source_documents`/`wiki_articles`), returns `500` `{"detail": "Document on disk lacks a registry row: {path}"}` — a data-integrity guard, not expected in normal operation. |
| Errors | `400` `{"detail": "Invalid document path: {path}"}` on a malformed path; `404` `{"detail": "Document not found: {path}"}` if truly missing (and not an archived-wiki case); `500` on registry mismatch (above). |

### GET `/chunks`

| | |
|---|---|
| Auth | vault member (inherited) |
| Query | `path: string`, `start: int`, `end: int` (required, no defaults) |
| Response | `200`, `Chunk[]` = `{ path, chunk_index, heading, body, content_hash }[]` (Zod on the frontend only validates `chunk_index`, `heading`, `body` — extra fields ignored, see oddities) |
| Behavior | `end` is clamped server-side to `min(end, start + 99)` — hard cap of 100 chunks per request, silently truncating rather than erroring on an oversized range. Reads from the search-index chunk table (`SearchService.fetch_chunk_range`), not from storage directly. |
| Scope judgment call | Not explicitly named in the M1 scope table, but consumed by the session-replay trace panel (`session-thread.tsx`), which **is** in scope (sessions reads). Included here as in-scope; flag for human confirmation. |

### GET `/links`

| | |
|---|---|
| Auth | vault member (inherited) |
| Query | `path: string` (required) |
| Response | `200`, `LinkedArticles` = `{ outgoing: WikiArticleOverview[], incoming: WikiArticleOverview[] }` (frontend Zod `linkItemSchema` only validates `{ file_path, title }` per item — `precis`/`updated_at`/`slug` silently dropped, see oddity #11) |
| Behavior | Reads the `backlinks` edge table (prose-derived by verify, not topic-level intent): `outgoing` = articles `path` cites, `incoming` = articles that cite `path`. Both directions **exclude archived articles** and are ordered `lower(title)` ascending. Returns `404` if `path` doesn't resolve to a live wiki article at all (vs. an article with zero links, which returns `200` with empty arrays). |
| Errors | `404` `{"detail": "Not a wiki article: {path}"}` |
| Scope judgment call | Same as `/chunks` — session-replay trace panel usage; the M1 scope table calls out "backlinks" explicitly under Documents, which most plausibly refers to this endpoint. Included as in-scope. |

---

## Sessions (`app/api/session_routes.py`)

Base path: `/sessions`, vault-scoped (member-gated at the parent router).

### GET `/sessions` — list

| | |
|---|---|
| Auth | vault member (inherited); also requires `CurrentUser` directly (used for filtering, not just auth) |
| Query | `limit`, `offset` |
| Response | `200`, `Page<SessionOverview>` |
| `SessionOverview` | `{ id: string, query: string, created_at: datetime, updated_at: datetime, user_id: uuid, origin: SessionOrigin\|null }`, `SessionOrigin = { doc_path: string, anchor: string\|null, paragraph: string\|null, paragraph_index: number\|null }` |
| **Behavior — scoped to caller** | The list is filtered to `user_id == caller.id` — **this endpoint only ever returns the calling user's own sessions**, not all sessions in the vault, regardless of role (even owners only see their own via this route). Sorted `updated_at DESC` (most recently active first), reading from the DB index table (`session_records`), not by scanning JSONL files. |

### GET `/sessions/{session_id}` — read/replay

| | |
|---|---|
| Auth | vault member (inherited) — **no ownership check**: any member of the vault can load any session id by guessing/being given it, regardless of who created it. This is the inverse of the list endpoint's scoping (see oddities). |
| Response | `200`, `SessionResponse` = `{ id: string, events: SessionEvent[] }` |
| `SessionEvent` | Discriminated union on `type`: `MetaEvent { type: "meta", id, query, ts: string(iso), user_id: string, origin: SessionOrigin\|null }`, `ExchangeEvent { type: "exchange", exId, query, thinking: ThinkingBlock[], answer, ts }`, `BtwEvent { type: "btw", exId, quote, blockOffset, context, exchanges: BtwExchange[], ts }`. `ThinkingBlock = { sources: ThinkingSource[] }`, `ThinkingSource = { label, type: "article"\|"raw"\|"search"\|"query"\|"links", thinking: string\|null, ranges: {start,end}[], full: boolean }`, `BtwExchange = { query, thinking: ThinkingBlock[], answer }`. |
| Behavior | Reads the raw JSONL event log line-by-line from vault storage (`sessions/{id}.jsonl`). **Truncates at the first line that fails `json.loads`** (partial-write recovery — a torn last line from a crashed writer is dropped, not surfaced as an error), and **silently skips** (with a server-side warning log only) any line whose `type` is unrecognized or that fails Pydantic validation for its declared type — the response simply omits that event, no error signal reaches the client. Order preserved as written (append-only log; no explicit re-sort). |
| Errors | `404` `{"detail": "Session not found"}` if the JSONL file doesn't exist: `SessionRepository.load_events` reads with the default `strict=True`, so a missing file raises `FileNotFoundError`, which **this route explicitly catches** and maps to 404 (contrast with the `/markdown` route, which has no such catch — oddity #15). If the file exists but is empty/all-malformed, returns `200` with `events: []` (not a 404). |

### GET `/sessions/{session_id}/markdown` — export

| | |
|---|---|
| Auth | vault member (inherited) |
| Response | `200`, `PlainTextResponse`, `Content-Type: text/markdown`, raw markdown string body (not JSON) |
| Behavior | Reads the **pre-rendered** `sessions/{id}.md` sidecar file (written at session-create/append time by `_rebuild_md`) — does **not** render on-the-fly from the JSONL on each request. If the sidecar was never written (session created via a path that skipped `_rebuild_md`, or the write failed), the actual behavior is a **500, not 404** — see Errors below and oddity #15. Rendering logic (for reference, not to be re-derived at request time by the TS port — but relevant if the TS port ever needs to regenerate it): one `# {query}` heading per exchange in encounter order, blockquoted source labels from `thinking[].sources[].label` under each exchange, the answer body, then any BTW threads for that exchange rendered as blockquotes — **BTW events are deduplicated to the latest by `ts` per `(exId, quote)` key** before rendering (a BTW thread accumulates one full-history JSONL line per reply, so naive rendering would repeat progressively-longer blocks). |
| Errors | **Actual: `500` (uncaught `FileNotFoundError`) on a missing `.md` sidecar.** `SessionRepository.read_markdown` calls `self.storage.read(f"sessions/{session_id}.md")` **without** `strict=False`; both storage backends raise `FileNotFoundError` when strict, so the route's `if markdown is None: raise HTTPException(404, "Session markdown not found")` branch is **dead code** — `None` is unreachable. The intended contract (a `404` `{"detail": "Session markdown not found"}`) is never produced. Live bug — see oddity #15 for the human decision on whether the TS implementation fixes it. |
| Frontend consumption | `web/src/api/sessions.ts::loadSessionMarkdown` calls `res.text()` directly — no Zod schema involved (this is the one in-scope endpoint with a non-JSON body). |

---

## Pagination envelope (`core/pagination.py`)

- `PageParams`: `{ limit: int (0–200, default 50), offset: int (>=0, default 0) }` — query params, shared across every paginated list route via `PageParamsQuery`.
- `PageInfo`: `PageParams` + `{ total: int }`.
- `Page<T>`: `{ items: T[], pagination: PageInfo }`.
- `FacetedPage<T, F>`: `Page<T>` + `{ facets: F }`.
- `FacetCount`: `{ value: string, count: number }`.
- Zod mirrors: `paginatedSchema(item)` = `{ items, pagination: pageInfoSchema }`; `facetedPaginatedSchema(item, facets)` extends that with `facets`. `pageInfoSchema = { limit, offset, total }` — all `z.number()`, matching.
- `VaultPage` is the one non-generic exception: `Page<Vault>` + `{ roles: Record<string,string> }` (see oddities — this duplicates the role that a plain per-item field would carry).

---

## Contract oddities

Recorded for human decision, not resolved:

1. **`WikiArticleOverview.precis` nullability mismatch.** Python: `precis: str` (required, non-null). Zod (`web/src/api/wiki.ts`): `precis: z.string().nullable()`. Frontend is defensively looser than the backend guarantees — either the backend contract should be trusted (tighten Zod) or there's a code path that actually produces null precis that the Python type doesn't admit.
2. **`GET /wiki/{slug}` appears unused by the frontend** (`web/src` has no caller), returns content **with frontmatter still attached** (inconsistent with `/doc/{path}`, which strips it), and has no archived-article fallback (so it dead-ends with 404 on a since-archived slug while `/doc/wiki/{slug}.md` resolves gracefully). Candidate for dropping entirely rather than porting, but scope table says "article read" under Wiki — needs a human call on whether this is legacy or a to-be-restored surface.
3. **`GET /vaults/{vault_id}` leaks vault existence to non-members.** Checks `vault exists` before `is member`, so a non-member probing a real vault id gets `403` while a bogus id gets `404` — existence is distinguishable pre-auth. `GET /vaults/{vault_id}/config`/`/members` don't have this issue (guard runs first, folding "vault doesn't exist" and "not a member" into the same 403 in practice for config, or straight to owner-guard 403 for members).
4. **`VaultPage.roles` is a redundant top-level map** duplicating what a plain array of `VaultWithRole` (role inlined per item, as `MembershipInternal`/members-list does) would express directly — same information, two shapes across two endpoints (`GET /vaults` uses the map; `GET /vaults/{id}/members` inlines role per item).
5. **`GET /vaults/{vault_id}/members` requires OWNER role**, not just membership — inconsistent with the "members can see who else is in the project" expectation implied by `VaultMemberGuard` existing as a distinct, weaker guard. Worth confirming this is intentional (privacy of member list) vs. an oversight.
6. **`GET /sessions` (list) is silently scoped to the caller's own sessions**, while **`GET /sessions/{id}` (read) has no ownership check** and will serve any vault member any session id in the vault. The asymmetry (can't discover others' sessions via list, but can read them directly if you know/guess the id) is worth a deliberate call — is session visibility meant to be private-by-default with sharing-by-link, or is the list endpoint under-scoped?
7. **`GET /sessions/{id}` silently drops malformed/unrecognized events** (bad JSON line truncates the whole tail of the log; a single bad event mid-log is skipped) with only a server log, no signal in the response (e.g., no `truncated: true` flag). A reimplementer must decide whether to preserve this "silently degrade" behavior or surface partial-read state to the client.
8. **`GET /sessions/{id}/markdown` serves a pre-rendered sidecar file, not a live render** — it can drift from, or fail independently of, the JSONL's actual state (e.g., a session whose events exist but whose `.md` write failed/was skipped — which currently surfaces as a 500, see #15). No route recomputes it on read.
9. **`WikiSort.CENTRAL`** exists in the domain enum and is fully implemented in the repository (`ORDER BY inbound_backlink_count DESC, lower(title)`) but is **not reachable via any in-scope HTTP route** — only `ALPHA` (`/wiki`) and `RECENT` (`/wiki/recent`) are exposed. Confirm this is deliberately unshipped (e.g., waiting on a "central" tab) rather than a route that got dropped.
10. **`/raw/sources` facet counts are unfiltered by the current query** — `source_types` facets always reflect the whole vault, not the current `search`/`source_type` filter view. This is a common and often-intentional faceted-search pattern (facets show what else you could filter to) but should be confirmed, since it means facet counts and the `pagination.total` on the same response can look inconsistent (total reflects the filter, facets don't).
11. **`Chunk` (backend) carries `path` and `content_hash`**; the frontend Zod schema for `/chunks` only declares `chunk_index`, `heading`, `body` and silently drops the rest (Zod's default non-strict parsing). Same pattern on **`/links`**: backend returns `WikiArticleOverview[]` per direction (`file_path`, `title`, `precis`, `updated_at`, `slug`), but `web/src/api/doc.ts::linkItemSchema` only captures `{ file_path, title }` and silently drops `precis`/`updated_at`/`slug`. Not bugs today, but a TS reimplementation authored fresh against "what the frontend needs" rather than "what the Python returns" could plausibly under-return fields if someone tries to shrink these payloads — flag so the fuller shapes are a deliberate choice, not a regression.
12. **`request-code`/`verify-code` under `suppress_auth=true`** bypass code generation and verification entirely — this is a test/dev escape hatch baked into the auth service itself (not just a test harness wrapper). Needs a decision on whether the TS port models this as a first-class config flag (matching behavior for the M1 test suite to exploit) or whether the TS integration tests drive real codes through a fake mailer instead.
13. **Login (`verify-code`) has a first-login side effect** (auto-creates a default vault) that is easy to under-model as "just returns tokens" — flagged here because it's a cross-domain side effect (auth → vaults) baked into an auth endpoint, not decomposed into a separate "ensure onboarded" step.
14. **500 on registry mismatch** (`/doc/{path}`: file on disk, no DB row) is a data-integrity assertion surfaced as an HTTP 500 with a specific message, rather than a typed 409/422 — a deliberate "this should never happen" signal, but worth a decision on whether the TS port keeps it as an opaque 500 (Effect defect) or gives it a typed error class since the inventory is supposed to document "errors actually produced."
15. **LIVE BUG — `GET /sessions/{id}/markdown` 404 branch is dead code; missing sidecar produces a 500.** `SessionRepository.read_markdown` reads `sessions/{id}.md` with the default `strict=True`, so a missing file raises `FileNotFoundError` (both backends) instead of returning `None`; the route's `if markdown is None: raise HTTPException(404, "Session markdown not found")` can never fire, and the client gets a generic uncaught-exception 500. The **intended** behavior is clearly the 404 with that detail message. Human decision required: should the TS implementation reproduce the current 500 (bug-for-bug) or implement the evidently intended 404? (Recommend deciding before the fixture for "jsonl exists, .md missing" is asserted against either status.)

---

## Fixture requirements

Derived from the behaviors documented above, the integration-test seed data needs:

- **Users**: at least 2 — one who owns a vault, one who is only a member (to exercise owner-only guards: `GET /vaults/{id}/members`, and role-based 403s generally). A third user with zero vault memberships, to exercise `ensure_default_for_user`'s auto-vault-creation on first login.
- **Vaults**: at least 2 vaults, one where a given user is `owner`, one where the same or another user is `editor`/`viewer` — to exercise `VaultPage.roles`, role-differentiated guard behavior, and the "member of vault A probing vault B" 403/404 distinction.
- **Vault memberships**: all three roles (`owner`, `editor`, `viewer`) represented across the fixture vaults, at least one vault with 3+ members to make `list_members` pagination and email-sort order observable.
- **Auth codes / refresh tokens**: seed at least one expired and one used-but-unexpired auth code (to hit the negative `verify-code` paths without relying on wall-clock timing in tests); an active refresh token and a revoked one (to hit refresh-reuse rejection).
- **API keys**: at least one active and one revoked key per test user (list must show both; revoke-on-already-revoked and revoke-not-owned must be exercisable).
- **Wiki articles**: several live articles with varied `updated_at` (to verify RECENT sort) and varied titles (to verify ALPHA/case-insensitive sort); at least one **archived** article whose topic has a `superseded_by` pointing at a live successor (to exercise the `/doc/wiki/...` archived-fallback path and its `archived`/`superseded_by` fields) and at least one archived article with **no** successor (`superseded_by: null` case); backlink edges between at least 3 articles (some with zero inbound links, to test `/links` empty-array vs 404-for-nonexistent-path distinction); an article produced by a specific `render_run_id` (to test the `/wiki?run=` filter) and one not.
- **Raw sources**: multiple `source_type` values (to test faceting and the `source_type` filter), at least one whose `title`/`author` contains a token to exercise the `search` ILIKE path (and one that shouldn't match, to confirm no false positives on precis/tags), a source with populated `derived_extras` (vault-configured custom fields) and one with empty, a source with non-null LLM-derived fields (post-compile) and one still null (pre-compile) — since `SourceDocument`'s LLM-derived fields are nullable until first compile.
- **Sessions**: a **multi-turn** session (2+ `ExchangeEvent`s) belonging to one user; a session with at least one `BtwEvent` thread with 2+ replies sharing the same `(exId, quote)` (to test markdown dedup-to-latest rendering, if the TS port needs to reproduce `_rebuild_md`); a session belonging to user A that user B (same-vault member) reads directly by id (to exercise/confirm the no-ownership-check-on-read behavior); a session whose `.jsonl` exists but whose `.md` sidecar is missing (to exercise the missing-sidecar case — **currently a 500 due to the dead 404 branch, oddity #15; the fixture's expected status depends on the human decision there**); a session JSONL with a deliberately malformed trailing line (partial-write truncation case) and one with a single malformed *interior* line (skip-and-continue case) — these need to be seeded as raw file content, not built through the (out-of-scope) write API. A session's `ThinkingBlock`/`ThinkingSource` data covering all five `type` values (`article`, `raw`, `search`, `query`, `links`) with populated `ranges`/`full`, to exercise `/chunks`+`/links` lazy-fetch consumers in the replay UI smoke test.
- **Cross-vault isolation**: at least one wiki article / source / session with the same-looking path or id pattern in two different vaults, to confirm vault-scoping doesn't leak across the `Storage` prefix boundary.
- **Registry mismatch**: one document file present in vault storage (`wiki/...` or `raw/...`) with **no** matching `wiki_articles`/`source_documents` row — to exercise the documented `500` `"Document on disk lacks a registry row"` path on `GET /doc/{path}`. Must be seeded as a raw storage write (bypassing ingest, which always writes the row).
- **Pagination boundaries**: enough rows in at least one paginated collection to exercise `limit=0` (empty items, correct `total`), the `limit=200` upper cap (and a `limit=201` request rejected as 422 by param validation), and an `offset` past `total` (must return `200` with an empty `items` page, not an error).
- **Account deletion (`DELETE /auth/me`)**: a dedicated throwaway user who **owns** one vault and is a **non-owner member** of another — to assert the owned vault is fully deleted (rows + storage) while the merely-membered vault survives with the membership row gone. Seed independently from all other fixtures since the cascade is destructive. (Alternative: declare account-deletion out of M1 fixture scope explicitly — but since `DELETE /auth/me` is an in-scope auth endpoint, coverage is recommended.)

---

## Explicitly out of M1 scope

One line each, per the parent doc's scope table + explicit exclusions:

- **Query/stream** (`query_routes.py`) — the query agent, SSE/streaming answer generation. Deferred to M3.
- **BTW** (`PATCH /sessions/{id}/btw`, and BTW-specific schemas) — annotation/thread creation. Deferred to M3 (though BTW *read* data appears embedded in session replay events, which is in scope as part of session reads — only the *write* path and any BTW-specific endpoints are excluded).
- **Ingest / staged uploads** (`ingest_routes.py` — `POST /`, `/user-suggestion`, `/upload`, `/url`, `/staged-files/*`) — all writes. Deferred to M3.
- **Compile / jobs / SSE progress** (`compile_routes.py`, `job_routes.py`) — pipeline run orchestration and progress streaming. Deferred to M4.
- **Proposals** (`proposal_routes.py`, and the proposal-adjacent writes in `wiki_routes.py`: `DELETE /raw/sources/{path}`, `POST /raw/sources/{path}/deletion-request`) — approval workflow.
- **Lint / explore** (`lint_routes.py`) — orphan/lint checks over the vault graph.
- **Cost routes** (`cost_routes.py`, both the top-level and vault-scoped mounts) — LLM cost observability endpoints.
- **All vault write endpoints**: `POST /vaults`, `POST /vaults/draft-hint`, `PATCH /vaults/{id}/config`, `POST /vaults/{id}/members`, `PUT /vaults/{id}/members/{user_id}`, `DELETE /vaults/{id}/members/{user_id}`, `POST /vaults/{id}/transfer-ownership`, `DELETE /vaults/{id}`.
- **All session write endpoints**: `POST /sessions`, `PATCH /sessions/{id}`, `PATCH /sessions/{id}/btw`, `POST /sessions/{id}/exchanges/{exchange_id}/promote`.
- **All wiki/document write endpoints**: `DELETE /raw/sources/{path}`, `POST /raw/sources/{path}/deletion-request`.
- **Any DDL / schema migration** — Alembic remains sole schema owner through M1; zero migrations, zero Drizzle-applied changes.
- **`app/api/schemas/ingest.py`, `jobs.py`, `query.py`, `tasks.py`** — schema modules backing the excluded routers above; not inventoried here.

---

## Resolved during inventory (follow-ups closed out)

- **`load_vault_config` merge behavior** (`core/vaults/config.py::load_vault_config`, read by `GET /vaults/{id}/config`): reads `config.yaml` from vault storage with `strict=False` — if the file is missing entirely, returns an **all-defaults** `VaultConfig` (`kinds = DEFAULT_KINDS = (person, event, organization, concept)`, `thematic_hint = ""`). If present, `kinds` is replaced wholesale by the file's `kinds` list when present and non-empty (no merge with defaults — falls back to `DEFAULT_KINDS` only if the key is absent/empty), `thematic_hint` similarly falls back to `""` only if absent/falsy. In practice `_init_vault_storage` always writes a default `config.yaml` at vault creation, so the missing-file branch is mostly a defensive fallback, not the common path. Note: the API-facing `VaultConfig` schema (`app/api/schemas/vaults.py`) only surfaces `thematic_hint`/`kinds` — the domain `VaultConfig` dataclass also carries `enriched_fields` and `web_search` (and a raw dict) that are **not exposed** by `GET /vaults/{id}/config` at all.
- **Dev proxy confirmed**: `web/vite.config.ts` proxies `^/api/...` → rewrites to `/v1/...` against the local Python backend (plus a special-cased SSE-friendly proxy for `/api/vaults/{id}/query/stream`, out of scope). So in dev, `VITE_API_BASE` defaults to `/api` and vite's own proxy performs the `/api` → `/v1` rewrite — meaning **both dev and prod ultimately hit `/v1/...` on the real server**, just via different mechanisms (vite proxy rewrite vs. baked-in prod env var). A TS server replacing the Python backend in dev must be mountable at `/v1` for the existing proxy rewrite to keep working unmodified.

## Notes on what could not be fully determined from the code

- **Whether unhandled exceptions produce a specific JSON error shape** — no custom FastAPI exception handler was found registered in `server.py`; default Starlette/FastAPI behavior for uncaught exceptions (bare `500`, generic body, no `detail` key) is assumed but not exhaustively traced through every service-layer exception type.
- **`VaultConfig.web_search`** (`core/vaults/config.py::load_vault_config`) does `data["web_search"]` — a **non-defaulted dict subscript**, meaning if `config.yaml` lacks a `web_search` key entirely, `load_vault_config` raises `KeyError` rather than falling back like `kinds`/`thematic_hint` do. Confirmed `web_search: false` is present in the package-bundled `default_config.yaml` (line 19), so every vault created via the normal `_init_vault_storage` path has it. Residual risk is only for a vault whose `config.yaml` predates this field or was hand-edited without it — low-probability in a fresh fixture set, but the TS port should decide deliberately whether to reproduce this strictness (raise) or harden it, per the "no fallbacks on things that must exist" house rule cutting both ways here. Moot for M1 anyway since `web_search` isn't in the exposed `VaultConfig` API schema.

## Decisions (2026-07-09)

Human decisions on the contract oddities that affect M1 implementation:

1. **Session markdown export, missing sidecar** → TS implements the intended `404` (`detail: "Session markdown not found"`). The Python 500 is a bug, not contract.
2. **`GET /sessions/{id}` authz** → keep vault-member access (current semantics). Whether session reads should be owner-scoped is a product question, deliberately not decided during the port.
3. **`GET /vaults/{id}` existence leak** → TS collapses to `403` for non-members regardless of vault existence, matching the `/config`/`/members` guard pattern.
4. **`GET /wiki/{slug}`** → not ported. Zero callers; article reads are path-addressed via `GET /doc/{path}`. Recorded as deliberate surface reduction, not an omission.
5. `suppress_auth` is ported as a first-class config flag (default false), matching Python's dev/test escape hatch.
6. 422 validation bodies are a flat `{"detail": string}` in TS (not FastAPI's structured array) — deliberate divergence; frontend only checks `res.ok` on error paths.
7. Vault storage side effects (config.yaml seed, R2 bucket provisioning/deletion) are deferred to the documents/storage task of M1 — `ensureDefaultForUser`/`deleteOwnedVaults` currently cover DB rows only; storage coverage must land before cutover.
8. `GET /vaults/{id}/config` in TS currently returns the documented defaults only — the storage-backed `config.yaml` merge lands with the documents/storage task (same tracking as decision 7). Until then customized vaults get defaults from the TS backend; must be resolved before cutover.
9. **Decision 8 resolved by M1 task 6** — `GET /vaults/{id}/config` now reads `config.yaml` through the TS `VaultStorage` read layer and applies the documented defaults/merge semantics for the API-exposed `thematic_hint` and `kinds` fields.
10. `GET .../links` in TS looks up the source article among live (non-archived) wiki rows only, so requesting links for an `archive/…` file path returns 404; Python returns 200 with links. Deliberate: matches the contract's "live wiki article" wording, unreachable from the frontend (which only passes `wiki/` paths).
11. Session replay in TS isolates events from the final valid `meta` event to EOF, dropping any stale prefix (logged as `session_stale_prefix_dropped`); Python returns all events. Rationale: the writer appends `meta` exactly once per session (verified — no title-update/resume path exists), so multi-meta JSONL files are only the corrupt merges produced by pre-`b929115` client-side session-id collisions; isolation repairs replay for those files and is a no-op for every server-minted session. Residual known inconsistency: the Python-rendered `.md` sidecar still contains the merged content for collided legacy ids, so markdown export and JSON replay may disagree there. Riding along: invalid session ids are 422 at the schema boundary in TS (Python: 404 via file miss — frontend only checks `res.ok`), and JSON-valid non-object lines are skipped in TS where Python 500s.
