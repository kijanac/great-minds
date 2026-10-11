# Privacy posture and provider options

> **Status:** exploratory proposal, not a verified decision. This note records ideas for future consideration.

## Problem

Great Minds currently treats cloud infrastructure as trusted for plaintext product state. Moving object files to an encrypted bucket or choosing a Swiss host helps, but by itself it does not solve the privacy problem because sensitive data is also stored and processed in the database, indexes, workflow state, model prompts, embeddings, reply checkpoints, logs, and web-search calls.

The privacy goal should be stated as a target trust boundary:

> Great Minds infrastructure should not need plaintext vault content to store, sync, or coordinate a user's vault.

That goal implies local-first execution for content-heavy work, not merely private cloud hosting.

## Current sensitive surfaces

Known current surfaces include:

- Object storage prefixes such as `vaults/`, `users/`, `proposals/`, `staging/`.
- Reply checkpoints like `operations/replies/<reply_id>.json`.
- Postgres plaintext/semantic fields:
  - `search_index.body`
  - `search_index.embedding`
  - `ideas.label`
  - `ideas.description`
  - `anchors.claim`
  - `anchors.quote`
  - `compile_cache_entries.value`
  - `replies.answer`
  - `replies.request`
  - `replies.sources`
  - `sessions.query`
  - `sessions.origin`
  - emails, auth metadata, share tokens
- LLM prompts, completions, embeddings, tool transcripts, and web-search query text.
- Logs and analytics, depending on what they include.

The important lesson: **encrypted file storage alone is insufficient** if DB rows, vector indexes, model calls, and checkpoints remain centralized in plaintext.

## Provider posture ladder

### Level 0 — current-style managed cloud

- App server, Postgres, object storage, model proxy, and email all run through managed providers.
- Operationally simple.
- Infrastructure can see most content.

This is easiest but weakest for the privacy goal.

### Level 1 — better jurisdiction and provider contracts

Move compute/database/object storage to privacy-friendlier providers or regions.

Possible provider classes:

- Swiss providers such as Exoscale or Infomaniak.
- EU-only object storage/compute where acceptable.
- Private Kubernetes/VPS plus managed Postgres.
- Cloudflare R2 jurisdiction restrictions where appropriate (`eu`, `us`, `fedramp`; not Swiss).

Benefits:

- Better jurisdictional posture.
- Potentially improved contractual terms.
- Lower risk of broad US provider exposure if that is a requirement.

Limits:

- Provider still sees plaintext DB/object data unless application-level encryption is added.
- Operators still receive model prompt traffic if the app server proxies model calls.
- Vector/search indexes remain highly revealing even without raw documents.

### Level 2 — centralized server with application-layer encryption

Encrypt sensitive columns/blobs before writing them to cloud storage.

Potential use:

- Encrypt raw sources and rendered articles.
- Encrypt reply transcripts/checkpoints.
- Encrypt compile cache entries.

Benefits:

- A cloud DB/object-store dump is less revealing.
- Can be layered incrementally.

Limits:

- Server cannot search/compile/query without keys.
- If the centralized app server has keys during requests, it still sees plaintext.
- Search/vector indexes are difficult to use without leaking content.
- Sharing/revocation becomes a key-management problem.

This can help as a transitional hardening step, but it is not as strong as local-first.

### Level 3 — local runtime with direct provider calls

Run the Great Minds API/runtime locally. Keep local DB/search/indexes/compile orchestration on device. Remote service is sync/backup/account coordination only.

Benefits:

- Great Minds' central server no longer sees prompts, source text, indexes, replies, or compile state.
- Users can choose local models, direct provider keys, or private endpoints.
- Existing product API can be preserved if local runtime serves the same `/v1` contract.

Limits:

- Packaging and local DB management become product concerns.
- Sync/sharing needs encrypted object protocol.
- Provider calls may still expose data to model providers.

This is the strongest practical direction.

### Level 4 — local-only / self-hosted models

All model work runs on local hardware or user-controlled private infrastructure.

Benefits:

- Minimal third-party prompt exposure.
- Best fit for sensitive vaults.

Limits:

- Model quality, latency, and hardware constraints.
- Compile quality may suffer unless private high-quality models are available.
- Harder support matrix.

## Model routing privacy modes

A future product could expose explicit modes rather than hiding provider tradeoffs.

### Local-only

- No external model calls.
- Use local embedding and LLM models.
- Web search disabled or explicit.
- Best for sensitive/private vaults.

### Direct BYOK / ZDR

- Local runtime sends prompts directly to user's chosen provider.
- User brings key.
- Provider selected for no-training/zero-data-retention where possible.
- Great Minds never proxies prompts.

For OpenRouter-like routing, require per-request/provider controls where supported:

```json
{
  "provider": {
    "zdr": true,
    "data_collection": "deny",
    "allow_fallbacks": false
  }
}
```

Also require account-level privacy settings where available. The request-level controls are not a substitute for checking provider terms.

### Private endpoint

- User or organization hosts model endpoint.
- Local runtime talks to that endpoint.
- Good enterprise/team option.

### Brokered convenience

- Great Minds hosts/proxies model calls for ease of use.
- Must be labeled as lower privacy.
- Could still enforce no-training providers and minimal retention.
- Should be opt-in for sensitive vaults.

## Web search and email

Even with local-first execution, web search can leak intent and content-derived questions. Future policy should distinguish:

- internal vault-only query
- external search allowed
- external search with sanitized query rewriting
- external search disabled for private vaults

Email providers receive addresses and invite content. Sharing links and membership invites should avoid putting vault-sensitive details in email body.

## Suggested near-term hardening without full local-first

These are incremental and do not require final architecture decisions:

1. Classify log fields and make sensitive fields impossible to log accidentally.
2. Remove large transcripts/tool outputs from workflow journals where possible; store compact cursors.
3. Encrypt reply checkpoints/object blobs with app-layer envelope keys if central server remains.
4. Avoid central model prompt proxying for advanced privacy mode; let local/runtime clients call providers directly.
5. Make provider privacy mode explicit in settings and UI.
6. Split authoritative state from rebuildable projections so indexes can move local later.
7. Add `requested_by_user_id` or equivalent audit fields for expensive/background operations.

## Open questions

- What privacy claim does the product want to make: jurisdictional, no-training, zero-retention, no-server-plaintext, or local-only?
- Are hosted convenience and strong privacy separate product modes?
- How much model quality degradation is acceptable for local/private models?
- Should public share links be disabled for high-privacy vaults?
- What metadata leakage remains acceptable: object counts, sizes, timing, collaborator graph, model usage?
