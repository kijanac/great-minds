# API Guidance

Great Minds has one backend capability set, but it is exposed through a few different API surfaces. Keep these concepts separate when designing routes, auth, and protocol schemas.

## Mental model

There are two independent axes:

1. Who is calling?
   - First-party web app
   - External developer/service
   - Another frontend or integration

2. What surface are they calling?
   - Native Great Minds product API
   - Query/agent API
   - OpenAI-compatible protocol API

The first-party frontend is the first client of the backend, not a special hidden backend citizen. It should use the same native product API that future official SDKs or external clients could use, subject to route-level auth policy.

## API surfaces

### Native product API

Examples:

```txt
/v1/me
/v1/vaults
/v1/vaults/:id/sources
/v1/vaults/:id/documents
/v1/ingestions
/v1/auth/api-keys
```

This is the Great Minds API. It should use Great-Minds-native concepts and schemas, not OpenAI-compatible wire shapes.

Used by:

- First-party frontend
- Future official SDKs
- External apps, if route policy allows it

Auth guidance:

- First-party frontend should use JWT session auth.
- API keys may access product routes when they have the required scope.
- Auth/account/API-key management routes should require a user session, not an API key.

### Query/agent API

Examples:

```txt
/v1/query
/v1/vaults/:id/query
/v1/agent
```

This exposes the core research assistant / thought partner capability against a user's vaults and documents.

Used by:

- First-party frontend
- External apps
- Automations
- Other frontends

Auth guidance:

- JWT session auth should be allowed for the first-party frontend.
- API key auth should be allowed for programmatic/external access.
- Do not make the first-party frontend mint or use a hidden default API key just to query. It already has a user session.

### OpenAI-compatible protocol API

Examples:

```txt
/v1/models
/v1/chat/completions
```

This is a compatibility adapter over Great Minds capabilities. It is not the whole product API.

Used by:

- OpenAI-compatible clients
- Tools expecting OpenAI wire formats

Auth guidance:

- API keys are required here.
- JWT sessions should not authenticate the OpenAI-compatible protocol surface; this keeps the external compatibility contract principled and credentialed like other programmatic clients.

## JWT sessions vs API keys

JWT access tokens represent an interactive user session.

Good for:

- First-party frontend
- Vault creation and management
- Document/source ingestion
- Account/session flows
- API key creation/revocation
- Querying from the first-party frontend

API keys represent delegated programmatic access.

Good for:

- External query access
- Integrations
- Automations
- OpenAI-compatible clients

Avoid using API keys for:

- Creating or revoking API keys
- Account/session management
- Broad destructive user operations unless explicitly scoped

## Route policy guidance

Current policy:

```txt
Unauthenticated:
  POST /auth/request-code
  POST /auth/verify-code
  POST /auth/refresh, using refresh token only

JWT session required:
  /v1/me
  /v1/auth/api-keys
  account/session/auth management

JWT session or API key with scope:
  native query/agent endpoints: query
  vault read endpoints: vaults:read
  vault write endpoints: vaults:write
  source/document read endpoints: sources:read
  source/document write/ingest endpoints: sources:write

API key with scope required:
  OpenAI-compatible endpoints: query
```

API key scopes:

```txt
query
vaults:read
vaults:write
sources:read
sources:write
```

## Auth context implication

Do not collapse authentication to only a `User` too early.

A route often needs to know not just which user authenticated, but how they authenticated.

Prefer preserving credential kind in auth context:

```ts
type AuthenticatedPrincipal =
  | {
      user: User;
      credential: { kind: "session" };
    }
  | {
      user: User;
      credential: { kind: "apiKey"; apiKeyId: ApiKeyId; scopes: ApiKeyScope[] };
    };
```

This enables route-level policy, auditing, rate limits, and API-key scope enforcement.

## Key principle

The first-party frontend should use JWT session auth. API keys are explicit user-created credentials for non-interactive or delegated access. The OpenAI-compatible API is a narrow compatibility surface, not the shape of the entire backend.
