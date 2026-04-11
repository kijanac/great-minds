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

## Brains

A brain is an isolated knowledge base. All content (raw sources, wiki articles, sessions) lives inside a brain. Users access brains through memberships with roles: `owner`, `editor`, or `viewer`.

### List your brains

```
GET /v1/brains
```

**Response:**

```json
[
  { "id": "uuid", "name": "Political Theory", "role": "owner" }
]
```

### Create a brain

```
POST /v1/brains
```

| Field  | Type   | Required | Description |
|--------|--------|----------|-------------|
| `name` | string | yes      | Brain name  |

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

### Get brain details

```
GET /v1/brains/{brain_id}
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
GET /v1/brains/{brain_id}/members
```

**Response:**

```json
[
  { "user_id": "uuid", "email": "user@example.com", "role": "editor" }
]
```

### Invite a member

```
POST /v1/brains/{brain_id}/members
```

Requires `owner` role. Sends an invitation email.

| Field   | Type   | Required | Default    | Description                        |
|---------|--------|----------|------------|------------------------------------|
| `email` | string | yes      |            | Email to invite                    |
| `role`  | string | no       | `"editor"` | One of: `owner`, `editor`, `viewer` |

**Response (201):** `MembershipOverview`

### Update a member's role

```
PUT /v1/brains/{brain_id}/members/{member_user_id}
```

Requires `owner` role.

| Field  | Type   | Required | Description                        |
|--------|--------|----------|------------------------------------|
| `role` | string | yes      | One of: `owner`, `editor`, `viewer` |

### Remove a member

```
DELETE /v1/brains/{brain_id}/members/{member_user_id}
```

Requires `owner` role. Returns `204 No Content`.

---

## Ingestion

Add raw source material to a brain. The brain must be compiled afterward for the content to appear in the wiki and become queryable.

All ingest endpoints are scoped to a brain: `/v1/brains/{brain_id}/ingest`

### Ingest text

```
POST /v1/brains/{brain_id}/ingest
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
POST /v1/brains/{brain_id}/ingest/upload
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
POST /v1/brains/{brain_id}/ingest/url
```

Fetches and ingests content from a URL.

| Field          | Type   | Required | Default   | Description     |
|----------------|--------|----------|-----------|-----------------|
| `url`          | string | yes      |           | URL to fetch    |
| `content_type` | string | no       | `"texts"` | Category folder |

**Response (201):** Same as text ingest.

---

## Compilation

Compilation processes raw sources into wiki articles. It runs as a background task through a multi-phase pipeline: enrich, plan, reconcile, write, index, and backlinks.

### Trigger compilation

```
POST /v1/brains/{brain_id}/compile
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

Query a brain's knowledge base using natural language. The query engine uses an LLM agent that can read wiki articles, follow source citations, and search across documents to ground its answers.

All query endpoints are scoped to a brain: `/v1/brains/{brain_id}/query`

### Query (non-streaming)

```
POST /v1/brains/{brain_id}/query
```

| Field                | Type   | Required | Default   | Description |
|----------------------|--------|----------|-----------|-------------|
| `question`           | string | yes      |           | Your question |
| `model`              | string | no       | server default | OpenRouter model ID to use |
| `origin_path`        | string | no       |           | Pre-load this document into context (e.g. `wiki/imperialism.md` or `raw/texts/lenin/imp/01.md`). Useful when the user is reading a specific document and asking about it. |
| `session_context`    | string | no       |           | Markdown of prior conversation to provide follow-up context. The engine uses this to understand references like "what did he mean by that?" |
| `mode`               | string | no       | `"query"` | `"query"` for full answers, `"btw"` for concise 2-3 paragraph responses |
| `extra_instructions` | string | no       |           | Additional instructions appended to the system prompt. Use this to control output format, tone, focus area, or any other behavioral guidance without modifying the brain's stored prompts. |

**Response:**

```json
{
  "answer": "According to [Imperialism, the Highest Stage](wiki/imperialism.md)..."
}
```

The `answer` field contains markdown with internal links to wiki articles and raw sources.

### Query (streaming)

```
POST /v1/brains/{brain_id}/query/stream
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
| `done`   | `{}` | Stream complete |
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
data: {}
```

### Using `extra_instructions`

The `extra_instructions` field lets you shape the engine's behavior per-request without modifying the brain's stored prompts. This is the primary integration point for wrapper services.

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
GET /v1/brains/{brain_id}/wiki
```

**Response:** Array of article slugs.

```json
["imperialism", "primitive-accumulation", "surplus-value"]
```

### Get recent articles

```
GET /v1/brains/{brain_id}/wiki/recent
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
GET /v1/brains/{brain_id}/wiki/{slug}
```

**Response:**

```json
{
  "slug": "imperialism",
  "content": "# Imperialism\n\nImperialism, as analyzed by..."
}
```

Returns `404` if the article doesn't exist.

### Read any document by path

```
GET /v1/brains/{brain_id}/doc/{path}
```

Read any wiki article or raw source by its full path. The path must start with `wiki/` or `raw/` and end with `.md`.

**Examples:**
- `GET /v1/brains/{brain_id}/doc/wiki/imperialism.md`
- `GET /v1/brains/{brain_id}/doc/raw/texts/lenin/imp/01.md`

**Response:**

```json
{
  "path": "raw/texts/lenin/imp/01.md",
  "content": "---\ntitle: Imperialism...\n---\n\n..."
}
```

### List raw sources

```
GET /v1/brains/{brain_id}/raw/sources
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
      "updated_at": "2026-01-10T08:00:00Z"
    }
  ],
  "content_types": [
    { "content_type": "texts", "count": 42 },
    { "content_type": "letters", "count": 15 }
  ]
}
```

---

## Sessions

Sessions persist research conversations (queries + answers + BTWs) as event logs within a brain.

### Create a session

```
POST /v1/brains/{brain_id}/sessions
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
PATCH /v1/brains/{brain_id}/sessions/{session_id}
```

Body: an `exchange` object (same shape as above).

### Append a BTW

```
PATCH /v1/brains/{brain_id}/sessions/{session_id}/btw
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
GET /v1/brains/{brain_id}/sessions
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
GET /v1/brains/{brain_id}/sessions/{session_id}
```

Returns the full event log for the session.

---

## Proposals

Source proposals let members suggest content for a brain. Owners review and approve/reject them. Approved proposals are automatically ingested and compiled.

### Create a proposal

```
POST /v1/brains/{brain_id}/proposals
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
  "brain_id": "uuid",
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
GET /v1/brains/{brain_id}/proposals
```

| Param    | Type   | Required | Description                                  |
|----------|--------|----------|----------------------------------------------|
| `status` | string | no       | Filter: `pending`, `approved`, or `rejected` |

### Get a proposal

```
GET /v1/brains/{brain_id}/proposals/{proposal_id}
```

### Review a proposal

```
PATCH /v1/brains/{brain_id}/proposals/{proposal_id}
```

Requires `owner` role.

| Field    | Type   | Required | Description                     |
|----------|--------|----------|---------------------------------|
| `status` | string | yes      | `"approved"` or `"rejected"`   |

Approved proposals are automatically ingested into the brain and trigger a compilation task.

---

## Lint

Returns pre-computed lint results for the brain's wiki. Lint runs automatically after each compilation.

### Get lint results

```
GET /v1/brains/{brain_id}/lint
```

**Response:**

```json
{
  "fixes_applied": [
    { "file": "wiki/imperialism.md", "description": "Fixed dead link to wiki/finance-capital.md" }
  ],
  "remaining_issues": 3,
  "counts": {
    "dead_links": 1,
    "broken_citations": 0,
    "orphans": 2,
    "uncompiled": 0,
    "uncited": 0,
    "missing_index": 0,
    "tag_issues": 0
  },
  "research_suggestions": [
    {
      "topic": "Finance Capital",
      "source": "Rudolf Hilferding",
      "mentioned_in": ["wiki/imperialism.md", "wiki/monopoly.md"],
      "usage_count": 5,
      "suggested_category": "texts"
    }
  ],
  "contradictions": [
    {
      "description": "Differing accounts of the role of banks in imperialism",
      "articles": ["wiki/imperialism.md", "wiki/finance-capital.md"]
    }
  ]
}
```

---

## Tasks

Background tasks (compilation, bulk ingest). Tasks are scoped to a brain.

### List tasks

```
GET /v1/brains/{brain_id}/tasks
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
GET /v1/brains/{brain_id}/tasks/{task_id}
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
2. **List brains** to find the brain ID you want to query
3. **Query** with `extra_instructions` to shape output for your use case
4. **Stream** responses for real-time UX, or use the non-streaming endpoint for batch processing

### Minimal query example (curl)

```bash
curl -X POST https://your-instance.com/v1/brains/{brain_id}/query \
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
    f"https://your-instance.com/v1/brains/{brain_id}/query/stream",
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
| 403  | Not a member of the brain, or insufficient role |
| 404  | Resource not found |
| 409  | Conflict (e.g. proposal already reviewed) |
| 503  | LLM service not configured (`OPENROUTER_API_KEY` missing) |
