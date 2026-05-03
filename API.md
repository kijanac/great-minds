# Great Minds API Reference

Base URL: `/v1`

All endpoints return JSON. Errors use standard HTTP status codes with a `{"detail": "..."}` body.

## Authentication

Every request (except auth endpoints) requires a Bearer token in the `Authorization` header:

```
Authorization: Bearer <token>
```

Two token types are accepted:

- **JWT access token** — obtained via the email code flow (short-lived)
- **API key** — created via `POST /v1/auth/api-keys` (long-lived, recommended for integrations)

### Request a login code

```
POST /v1/auth/request-code
```

Sends a one-time code to the given email address.

| Field   | Type   | Required | Description         |
|---------|--------|----------|---------------------|
| `email` | string | yes      | User's email address |

Returns `204 No Content` on success.

### Verify code and get tokens

```
POST /v1/auth/verify-code
```

| Field   | Type   | Required | Description                    |
|---------|--------|----------|--------------------------------|
| `email` | string | yes      | Email used in `request-code`   |
| `code`  | string | yes      | Code received via email        |

**Response:**

```json
{
  "access_token": "eyJ...",
  "refresh_token": "eyJ...",
  "token_type": "bearer"
}
```

### Refresh tokens

```
POST /v1/auth/refresh
```

| Field           | Type   | Required | Description            |
|-----------------|--------|----------|------------------------|
| `refresh_token` | string | yes      | A valid refresh token  |

Returns a new `TokenPair` (same shape as verify-code).

### Create an API key

```
POST /v1/auth/api-keys
```

Requires authentication. Creates a long-lived API key for programmatic access.

| Field   | Type   | Required | Description       |
|---------|--------|----------|-------------------|
| `label` | string | yes      | Human-readable label |

**Response (201):**

```json
{
  "id": "uuid",
  "label": "my-integration",
  "revoked": false,
  "created_at": "2026-01-01T00:00:00Z",
  "raw_key": "gm_..."
}
```

The `raw_key` is only returned once. Store it securely.

### Revoke an API key

```
DELETE /v1/auth/api-keys/{key_id}
```

Returns `204 No Content`.

---

## Vaults

A vault is an isolated knowledge base. All content (raw sources, wiki articles, sessions) lives inside a vault. Users access vaults through memberships with roles: `owner`, `editor`, or `viewer`.

### List your vaults

```
GET /v1/vaults
```

**Response:**

```json
[
  { "id": "uuid", "name": "Political Theory", "role": "owner" }
]
```

### Create a vault

```
POST /v1/vaults
```

| Field  | Type   | Required | Description |
|--------|--------|----------|-------------|
| `name` | string | yes      | Vault name  |

**Response (201):**

```json
{
  "id": "uuid",
  "name": "Political Theory",
  "role": "owner",
  "owner_id": "uuid",
  "created_at": "2026-01-01T00:00:00Z"
}
```

### Get vault details

```
GET /v1/vaults/{vault_id}
```

**Response:**

```json
{
  "id": "uuid",
  "name": "Political Theory",
  "role": "owner",
  "owner_id": "uuid",
  "created_at": "2026-01-01T00:00:00Z",
  "member_count": 3,
  "article_count": 142
}
```

### List members

```
GET /v1/vaults/{vault_id}/members
```

**Response:**

```json
[
  { "user_id": "uuid", "email": "user@example.com", "role": "editor" }
]
```

### Invite a member

```
POST /v1/vaults/{vault_id}/members
```

Requires `owner` role. Sends an invitation email.

| Field   | Type   | Required | Default    | Description                        |
|---------|--------|----------|------------|------------------------------------|
| `email` | string | yes      |            | Email to invite                    |
| `role`  | string | no       | `"editor"` | One of: `owner`, `editor`, `viewer` |

**Response (201):** `MembershipOverview`

### Update a member's role

```
PUT /v1/vaults/{vault_id}/members/{member_user_id}
```

Requires `owner` role.

| Field  | Type   | Required | Description                        |
|--------|--------|----------|------------------------------------|
| `role` | string | yes      | One of: `owner`, `editor`, `viewer` |

### Remove a member

```
DELETE /v1/vaults/{vault_id}/members/{member_user_id}
```

Requires `owner` role. Returns `204 No Content`.

---

## Ingestion

Add raw source material to a vault. The vault must be compiled afterward for the content to appear in the wiki and become queryable.

All ingest endpoints are scoped to a vault: `/v1/vaults/{vault_id}/ingest`

### Ingest text

```
POST /v1/vaults/{vault_id}/ingest
```

| Field            | Type   | Required | Default    | Description                                |
|------------------|--------|----------|------------|--------------------------------------------|
| `content`        | string | yes      |            | Raw text or markdown content               |
| `dest`           | string | yes      |            | Destination path within `raw/` (e.g. `texts/marx/capital-ch1.md`) |
| `content_type`   | string | no       | `"texts"`  | Category folder (e.g. `texts`, `letters`)  |
| `title`          | string | no       |            | Document title (extracted from content if omitted) |
| `author`         | string | no       |            | Author name                                |
| `published_date` | string | no       |            | Original publication date                  |
| `origin`         | string | no       |            | Where the content came from                |
| `url`            | string | no       |            | Source URL                                 |

**Response (201):**

```json
{
  "file_path": "raw/texts/marx/capital-ch1.md",
  "title": "Capital, Chapter 1"
}
```

### Ingest file upload

```
POST /v1/vaults/{vault_id}/ingest/upload
```

Multipart form upload. Accepts `.md`, `.txt`, and `.pdf` files.

| Field          | Type   | Required | Default   | Description              |
|----------------|--------|----------|-----------|--------------------------|
| `file`         | file   | yes      |           | The file to upload       |
| `content_type` | string | no       | `"texts"` | Category folder          |
| `author`       | string | no       |           | Author name              |
| `date`         | string | no       |           | Publication date         |
| `origin`       | string | no       |           | Content origin           |
| `url`          | string | no       |           | Source URL               |
| `dest_path`    | string | no       |           | Override destination path |

All optional fields are query parameters, not part of the multipart body.

**Response (201):** Same as text ingest.

### Ingest from URL

```
POST /v1/vaults/{vault_id}/ingest/url
```

Fetches and ingests content from a URL.

| Field          | Type   | Required | Default   | Description     |
|----------------|--------|----------|-----------|-----------------|
| `url`          | string | yes      |           | URL to fetch    |
| `content_type` | string | no       | `"texts"` | Category folder |

**Response (201):** Same as text ingest.

### Ingest user suggestion

```
POST /v1/vaults/{vault_id}/ingest/user-suggestion
```

Persists a structured user suggestion as a source document under `raw/user/` with `source_type: "user"`. The suggestion enters the pipeline through the same rail as any other document and influences the next compile.

| Field              | Type   | Required | Description                                        |
|--------------------|--------|----------|----------------------------------------------------|
| `body`             | string | yes      | Substantive prose in the user's own words          |
| `intent`           | string | yes      | One of `disagree`, `correct`, `add_context`, `restructure` |
| `anchored_to`      | string | no       | Slug of the wiki concept the suggestion targets    |
| `anchored_section` | string | no       | Highlighted passage or section header for context  |

**Response (201):** Same as text ingest.

---

## Compilation

Compilation processes raw sources into wiki articles. It runs as a background task through the six-phase pipeline: extract per-document cards, distill into a concept registry, archive retired slugs, render articles, cross-link the wiki, and assemble the mechanical index.

### Trigger compilation

```
POST /v1/vaults/{vault_id}/compile
```

Returns immediately with a task you can poll.

| Field   | Type    | Required | Default | Description                      |
|---------|---------|----------|---------|----------------------------------|
| `limit` | integer | no       | all     | Max number of documents to compile |

**Response:**

```json
{
  "id": "uuid",
  "type": "compile",
  "status": "pending",
  "created_at": "2026-01-01T00:00:00Z",
  "params": { "limit": null },
  "error": null,
  "result": {}
}
```

Requires `OPENROUTER_API_KEY` to be configured (returns `503` otherwise).

---

## Query

Query a vault's knowledge base using natural language. The query engine uses an LLM agent that can read wiki articles, follow source citations, and search across documents to ground its answers.

All query endpoints are scoped to a vault: `/v1/vaults/{vault_id}/query`

### Query (non-streaming)

```
POST /v1/vaults/{vault_id}/query
```

| Field                | Type   | Required | Default   | Description |
|----------------------|--------|----------|-----------|-------------|
| `question`           | string | yes      |           | Your question |
| `model`              | string | no       | server default | OpenRouter model ID to use |
| `origin_path`        | string | no       |           | Pre-load this document into context (e.g. `wiki/imperialism.md` or `raw/texts/lenin/imp/01.md`). Useful when the user is reading a specific document and asking about it. |
| `session_context`    | string | no       |           | Markdown of prior conversation to provide follow-up context. The engine uses this to understand references like "what did he mean by that?" |
| `mode`               | string | no       | `"query"` | `"query"` for full answers, `"btw"` for concise 2-3 paragraph responses |
| `extra_instructions` | string | no       |           | Additional instructions appended to the system prompt. Use this to control output format, tone, focus area, or any other behavioral guidance without modifying the vault's stored prompts. |

**Response:**

```json
{
  "answer": "According to [Imperialism, the Highest Stage](wiki/imperialism.md)...",
  "sources_consulted": [
    { "kind": "wiki", "path": "wiki/imperialism.md" },
    { "kind": "raw", "path": "raw/texts/lenin/imp/01.md" }
  ]
}
```

The `answer` field contains markdown with internal links to wiki articles and raw sources.

The `sources_consulted` field lists every document the engine read while producing the answer, deduplicated and in the order first consulted. `kind` is either `"wiki"` (a compiled wiki article) or `"raw"` (a primary source document). Use this to render a bibliography or fetch full source content via `GET /v1/vaults/{vault_id}/doc/{path}`.

### Query (streaming)

```
POST /v1/vaults/{vault_id}/query/stream
```

Same request body as the non-streaming endpoint. Returns a `text/event-stream` SSE response.

**Event types:**

| Event    | Data                                         | Description |
|----------|----------------------------------------------|-------------|
| `source` | `{"type": "article", "path": "wiki/..."}` | The engine read a wiki article |
| `source` | `{"type": "raw", "path": "raw/texts/..."}` | The engine read a raw source |
| `source` | `{"type": "search", "query": "..."}` | The engine searched the wiki |
| `source` | `{"type": "query", "filters": {...}}` | The engine ran a structured metadata query |
| `token`  | `{"text": "..."}` | A chunk of the response text |
| `done`   | `{"sources_consulted": [...]}` | Stream complete; includes the final deduplicated list of documents read |
| `error`  | `{"message": "..."}` | Something went wrong |

**Example SSE stream:**

```
event: source
data: {"type": "article", "path": "wiki/imperialism.md"}

event: source
data: {"type": "raw", "path": "raw/texts/lenin/imp/01.md"}

event: token
data: {"text": "According to "}

event: token
data: {"text": "Lenin's analysis..."}

event: done
data: {"sources_consulted": [{"kind": "wiki", "path": "wiki/imperialism.md"}, {"kind": "raw", "path": "raw/texts/lenin/imp/01.md"}]}
```

### Using `extra_instructions`

The `extra_instructions` field lets you shape the engine's behavior per-request without modifying the vault's stored prompts. This is the primary integration point for wrapper services.

**Examples:**

```json
{
  "question": "What were the key debates around imperialism?",
  "extra_instructions": "You are writing a script for a political commentary video. Structure your response with clear sections, use a conversational but authoritative tone, and keep it under 800 words."
}
```

```json
{
  "question": "Compare Marx and Lenin on the state",
  "extra_instructions": "Respond as a structured JSON object with fields: thesis, key_points (array), sources_cited (array of paths), and open_questions (array)."
}
```

```json
{
  "question": "What is primitive accumulation?",
  "extra_instructions": "Explain as if to a university undergraduate with no prior exposure to Marxist theory. Avoid jargon. Use concrete historical examples from the sources."
}
```

---

## Wiki

Read wiki articles and browse raw sources. These are read-only endpoints for accessing compiled content.

### List wiki articles

```
GET /v1/vaults/{vault_id}/wiki
```

**Response:** Array of article slugs.

```json
["imperialism", "primitive-accumulation", "surplus-value"]
```

### Get recent articles

```
GET /v1/vaults/{vault_id}/wiki/recent
```

| Param   | Type    | Required | Default | Description       |
|---------|---------|----------|---------|-------------------|
| `limit` | integer | no       | 10      | Max results       |

**Response:**

```json
[
  {
    "title": "Imperialism",
    "file_path": "wiki/imperialism.md",
    "doc_kind": "wiki",
    "updated_at": "2026-01-15T12:00:00Z"
  }
]
```

### Read a wiki article

```
GET /v1/vaults/{vault_id}/wiki/{slug}
```

**Response:**

```json
{
  "slug": "imperialism",
  "content": "# Imperialism\n\nImperialism, as analyzed by...",
  "archived": false,
  "superseded_by": null
}
```

If the slug's active article is missing but a retired concept with that slug exists in the archive, the archived article is returned with `archived: true` and `superseded_by` set to the successor slug (or `null` if no successor was identified). Returns `404` only when no active or archived article matches.

### Read an archived article by concept_id

```
GET /v1/vaults/{vault_id}/wiki/archive/{concept_id}
```

Fetches an archived article directly by its concept_id. Returns the same shape as above with `archived: true`. Returns `404` if the concept is not archived or its archive file is missing.

### Read any document by path

```
GET /v1/vaults/{vault_id}/doc/{path}
```

Read any wiki article or raw source by its full path. The path must start with `wiki/` or `raw/` and end with `.md`.

**Examples:**
- `GET /v1/vaults/{vault_id}/doc/wiki/imperialism.md`
- `GET /v1/vaults/{vault_id}/doc/raw/texts/lenin/imp/01.md`

**Response:**

```json
{
  "path": "raw/texts/lenin/imp/01.md",
  "content": "---\ntitle: Imperialism...\n---\n\n...",
  "archived": false,
  "superseded_by": null
}
```

Wiki paths (`wiki/<slug>.md`) follow the same archive-fallback rule as `GET /wiki/{slug}`: a miss on the active file resolves against the archive with `archived: true` and `superseded_by` set when a successor exists.

### List raw sources

```
GET /v1/vaults/{vault_id}/raw/sources
```

| Param          | Type    | Required | Default | Description                  |
|----------------|---------|----------|---------|------------------------------|
| `content_type` | string  | no       |         | Filter by category (e.g. `texts`) |
| `search`       | string  | no       |         | Search within titles         |
| `compiled`     | boolean | no       |         | Filter by compilation status |
| `limit`        | integer | no       | 50      | Max results                  |
| `offset`       | integer | no       | 0       | Pagination offset            |

**Response:**

```json
{
  "items": [
    {
      "title": "Capital, Chapter 1",
      "file_path": "raw/texts/marx/capital-ch1.md",
      "author": "Karl Marx",
      "origin": "marxists.org",
      "published_date": "1867",
      "compiled": true,
      "source_type": "document",
      "updated_at": "2026-01-10T08:00:00Z"
    }
  ],
  "content_types": [
    { "content_type": "texts", "count": 42 },
    { "content_type": "letters", "count": 15 }
  ]
}
```

`source_type` is `"document"` for ingested materials and `"user"` for structured user suggestions authored via `POST /ingest/user-suggestion`.

---

## Sessions

Sessions persist research conversations (queries + answers + BTWs) as event logs within a vault.

### Create a session

```
POST /v1/vaults/{vault_id}/sessions
```

| Field        | Type   | Required | Description                      |
|--------------|--------|----------|----------------------------------|
| `session_id` | string | yes      | Client-generated session ID      |
| `exchange`   | object | yes      | First query/answer exchange      |
| `origin`     | string | no       | Document the session started from |

**Exchange object:**

| Field      | Type   | Required | Description           |
|------------|--------|----------|-----------------------|
| `query`    | string | yes      | The user's question   |
| `answer`   | string | yes      | The engine's response |
| `thinking` | array  | no       | Thinking/source blocks (internal use) |

**Response (201):**

```json
{ "path": "sessions/abc123.jsonl" }
```

### Append an exchange

```
PATCH /v1/vaults/{vault_id}/sessions/{session_id}
```

Body: an `exchange` object (same shape as above).

### Append a BTW

```
PATCH /v1/vaults/{vault_id}/sessions/{session_id}/btw
```

| Field            | Type    | Required | Description                    |
|------------------|---------|----------|--------------------------------|
| `exchangeId`     | string  | yes      | Which exchange this BTW is on  |
| `anchor`         | string  | yes      | The highlighted text           |
| `paragraph`      | string  | yes      | Full paragraph containing the anchor |
| `paragraphIndex` | integer | no       | Index of the paragraph in the answer |
| `messages`       | array   | yes      | Array of `{role, text}` message objects |

### List sessions

```
GET /v1/vaults/{vault_id}/sessions
```

**Response:**

```json
[
  {
    "id": "abc123",
    "query": "What is surplus value?",
    "created": "2026-01-15T12:00:00Z",
    "updated": "2026-01-15T12:05:00Z",
    "origin": "wiki/surplus-value.md"
  }
]
```

### Read a session

```
GET /v1/vaults/{vault_id}/sessions/{session_id}
```

Returns the full event log for the session.

---

## Proposals

Source proposals let members suggest content for a vault. Owners review and approve/reject them. Approved proposals are automatically ingested and compiled.

### Create a proposal

```
POST /v1/vaults/{vault_id}/proposals
```

| Field          | Type   | Required | Default   | Description        |
|----------------|--------|----------|-----------|--------------------|
| `content`      | string | yes      |           | The proposed text  |
| `content_type` | string | no       | `"texts"` | Category folder    |
| `title`        | string | no       |           | Document title     |
| `author`       | string | no       |           | Author name        |

**Response (201):**

```json
{
  "id": "uuid",
  "vault_id": "uuid",
  "user_id": "uuid",
  "status": "pending",
  "title": "On Contradiction",
  "content_type": "texts",
  "author": "Mao Zedong",
  "created_at": "2026-01-15T12:00:00Z",
  "reviewed_by": null,
  "reviewed_at": null
}
```

### List proposals

```
GET /v1/vaults/{vault_id}/proposals
```

| Param    | Type   | Required | Description                                  |
|----------|--------|----------|----------------------------------------------|
| `status` | string | no       | Filter: `pending`, `approved`, or `rejected` |

### Get a proposal

```
GET /v1/vaults/{vault_id}/proposals/{proposal_id}
```

### Review a proposal

```
PATCH /v1/vaults/{vault_id}/proposals/{proposal_id}
```

Requires `owner` role.

| Field    | Type   | Required | Description                     |
|----------|--------|----------|---------------------------------|
| `status` | string | yes      | `"approved"` or `"rejected"`   |

Approved proposals are automatically ingested into the vault and trigger a compilation task.

---

## Lint

Returns a detection-only report over the current vault state. Computed on demand from the compile artifacts — no LLM calls, no mutation. The report surfaces four kinds of signal the caller can act on.

### Get lint report

```
GET /v1/vaults/{vault_id}/lint
```

**Response:**

```json
{
  "research_suggestions": [
    {
      "topic": "Finance Capital",
      "mentioned_in": ["raw/texts/imperialism-01.md", "raw/texts/monopoly-02.md"],
      "usage_count": 5
    }
  ],
  "orphans": [
    { "slug": "narodniks", "canonical_label": "Narodniks" }
  ],
  "dirty_concepts": [
    "019da12d-8a05-7d7d-88e4-8ff9df3a70db"
  ],
  "contradictions": []
}
```

| Field                  | Meaning |
|------------------------|---------|
| `research_suggestions` | Topics the corpus mentions in document frontmatter but never clustered into a first-class concept. Each entry gives the topic, a sample of documents that mentioned it, and total mention count. |
| `orphans`              | Rendered articles whose slug has no incoming wiki backlinks. |
| `dirty_concepts`       | `concept_id`s whose rendered article has drifted from the current compile inputs (e.g. cluster members changed since the last render). These will be refreshed on the next compile. |
| `contradictions`       | Reserved for future tool-grounded lint. Currently always empty. |

---

## Tasks

Background tasks (compilation, bulk ingest). Tasks are scoped to a vault.

### List tasks

```
GET /v1/vaults/{vault_id}/tasks
```

**Response:**

```json
[
  {
    "id": "uuid",
    "type": "compile",
    "status": "completed",
    "created_at": "2026-01-15T12:00:00Z",
    "params": {},
    "error": null,
    "result": { "articles_written": 12 }
  }
]
```

Task statuses: `pending`, `running`, `completed`, `failed`, `cancelled`.

### Get a task

```
GET /v1/vaults/{vault_id}/tasks/{task_id}
```

---

## Health

```
GET /health
```

No authentication required.

**Response:**

```json
{ "status": "ok" }
```

---

## Integration Guide

### Typical workflow for a wrapper service

1. **Authenticate** with an API key (create one via the web UI or `POST /v1/auth/api-keys`)
2. **List vaults** to find the vault ID you want to query
3. **Query** with `extra_instructions` to shape output for your use case
4. **Stream** responses for real-time UX, or use the non-streaming endpoint for batch processing

### Minimal query example (curl)

```bash
curl -X POST https://your-instance.com/v1/vaults/{vault_id}/query \
  -H "Authorization: Bearer gm_your_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "question": "What were the main arguments in the imperialism debate?",
    "extra_instructions": "Respond in bullet points. Keep it under 500 words."
  }'
```

### Streaming example (Python)

```python
import httpx

with httpx.stream(
    "POST",
    f"https://your-instance.com/v1/vaults/{vault_id}/query/stream",
    headers={"Authorization": f"Bearer {api_key}"},
    json={
        "question": "Summarize the theory of surplus value",
        "extra_instructions": "Write for a general audience.",
    },
) as response:
    for line in response.iter_lines():
        if line.startswith("event: "):
            event_type = line[7:]
        elif line.startswith("data: "):
            data = line[6:]
            if event_type == "token":
                print(data, end="", flush=True)
```

### Error codes

| Code | Meaning |
|------|---------|
| 400  | Bad request (invalid path, malformed body) |
| 401  | Missing or invalid credentials |
| 403  | Not a member of the vault, or insufficient role |
| 404  | Resource not found |
| 409  | Conflict (e.g. proposal already reviewed) |
| 503  | LLM service not configured (`OPENROUTER_API_KEY` missing) |
