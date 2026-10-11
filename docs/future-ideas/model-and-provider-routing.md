# Model and provider routing ideas

> **Status:** exploratory proposal, not a verified decision. This note records model-routing ideas connected to privacy and local-first work.

## Goal

Great Minds should eventually make model-provider privacy a visible mode, not an implicit backend implementation detail.

A user should be able to understand whether vault content is sent to:

- no external provider;
- a local model only;
- a direct provider using the user's key;
- a private endpoint;
- a Great Minds brokered provider;
- open web search providers.

## Routing modes

### Local-only mode

- Use local embeddings and local LLMs.
- Disable external web search.
- Disable brokered provider calls.
- Best for sensitive vaults.

Potential compromises:

- slower compile;
- weaker synthesis/prose quality;
- more local hardware requirements.

### Direct BYOK mode

- Local runtime calls provider directly with user's API key.
- Great Minds server never sees prompt or response.
- Provider terms still matter.

Settings should include:

- provider name;
- model IDs for query/reply/compile/embedding;
- privacy posture notes;
- data-retention/training flags where supported;
- fallback policy.

### ZDR/no-training routed mode

If using an aggregator such as OpenRouter, requests should set strict provider options where supported:

```json
{
  "provider": {
    "zdr": true,
    "data_collection": "deny",
    "allow_fallbacks": false
  }
}
```

Rationale:

- `zdr: true` requests zero-data-retention providers.
- `data_collection: "deny"` rejects providers that collect data where the router supports this control.
- `allow_fallbacks: false` prevents silent fallback to a less-private provider.

Also require account-level privacy controls when available. Per-request flags are not enough by themselves.

### Private endpoint mode

- User/organization provides an OpenAI-compatible or custom endpoint.
- Could be self-hosted, VPC, Swiss/EU private infrastructure, or enterprise model gateway.
- Good for teams that need central control without giving Great Minds plaintext.

### Brokered convenience mode

- Great Minds backend proxies provider calls.
- Easiest onboarding.
- Weakest privacy boundary.
- Should be clearly labeled and avoid sensitive-vault defaults.

Brokered mode can still be improved by:

- routing only to no-training/ZDR providers;
- minimizing logs;
- avoiding prompt storage;
- using short-lived request IDs;
- never sending vault identifiers in provider metadata where not needed.

## Workload-specific routing

Different workloads may use different privacy/quality profiles.

### Embeddings

Embeddings are sensitive. They leak semantic information even without raw text.

Options:

- local embedding model for private mode;
- direct BYOK embedding provider;
- encrypted/not-synced vector indexes;
- rebuild embeddings locally per device;
- do not upload embeddings to central infrastructure.

### Query/reply

The reply path sends highly sensitive context:

- user question;
- selected source excerpts;
- session history;
- tool outputs;
- web search queries/results.

Privacy mode should be shown per vault or per query.

### Compile

Compile may send the largest volume of source content and extracted ideas to models.

Potential policies:

- local/private compile only for private vaults;
- remote high-quality compile only after explicit opt-in;
- split compile phases by privacy risk:
  - local extract/embedding;
  - remote reduce/render only on minimized idea records;
  - or all remote when convenience mode selected.

### Web search

Web search leaks query intent. Modes:

- disabled;
- ask every time;
- allowed with sanitized query rewriting;
- allowed unrestricted.

Search results should be cited as external and not silently blended into canonical vault content unless explicitly saved.

## UX ideas

Per vault, show a privacy badge:

- **Local only** — no external model/search calls.
- **Direct provider** — sent directly from your device to configured provider.
- **Private endpoint** — sent to your configured endpoint.
- **Brokered** — routed through Great Minds.
- **Web enabled** — may query external web search.

Per operation, show:

- model/provider used;
- whether web search was used;
- whether content was sent externally;
- approximate cost;
- whether the result is local-only or synced.

## Open questions

- Should privacy mode be per account, per vault, or per operation?
- Can a high-privacy vault disable brokered mode entirely?
- Should model routing be part of signed vault config in shared vaults?
- How should collaborators agree on provider/model choices for canonical compile snapshots?
- Can model prompts be minimized enough for remote compile without unacceptable quality loss?
