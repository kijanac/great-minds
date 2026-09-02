# Great Minds HTTP API Reference

This document describes the public HTTP API of the Great Minds server. It is
intended for external developers building wrapper services, scripts, and other
integrations against the server.

The API is JSON over HTTP. All versioned endpoints live under the `/v1`
prefix. Most endpoints require authentication with a bearer token (see
[Authentication](#authentication)); the exceptions are the code-based
authentication entry points, passkey authentication option/verification,
the health endpoint, and public share resolution.

The current version of the document covers every endpoint exposed by the
server, the exact request and response shapes, error semantics, and the
server-sent event (SSE) streams used for long-running work.

## Contents

- [Conventions](#conventions)
- [Authentication](#authentication)
- [Errors](#errors)
- [Pagination](#pagination)
- [Endpoint reference](#endpoint-reference)
  - [Auth](#auth)
  - [Meta](#meta)
  - [Refs](#refs)
  - [Vaults](#vaults)
  - [Wiki](#wiki)
  - [Sources](#sources)
  - [Proposals](#proposals)
  - [Ingest](#ingest)
  - [Jobs](#jobs)
  - [Compile](#compile)
  - [Lint](#lint)
  - [Costs](#costs)
  - [Documents](#documents)
  - [Sessions](#sessions)
  - [Replies](#replies)
  - [Shares](#shares)
  - [Public](#public)
- [Integration guide](#integration-guide)
  - [Authenticating](#authenticating)
  - [Listing vaults](#listing-vaults)
  - [Creating a reply](#creating-a-reply)
  - [Consuming the reply stream](#consuming-the-reply-stream)
  - [Pagination](#pagination-1)
  - [Errors table](#errors-table)
- [Endpoint index](#endpoint-index)

## Conventions

### Base URL

All endpoints in the endpoint reference are shown with their full path,
including the `/v1` prefix. For example, the vault list endpoint is:

```
GET /v1/vaults
```

The server may be reached at a host such as `https://api.example.com`; the
full URL for that request would be `https://api.example.com/v1/vaults`.

Two routes live outside the `/v1` prefix:

- `GET /` - operational health check, returns `200` with
  `{"status":"ok"}`.
- `GET /health` - same as above.

One route under `/v1` is not JSON: `POST /v1/file-ingests/:batch_id/files/:hash`,
the raw multipart file upload route (documented in
[Ingest](#raw-file-upload-route)).

### Content types

- Requests and responses are `application/json` unless stated otherwise.
- `GET /v1/vaults/:vault_id/sessions/:session_id/markdown` returns
  `text/markdown`.
- The two stream endpoints (`/stream`) return `text/event-stream`.
- The raw file upload route accepts `multipart/form-data`.

### Identifiers

Field names on the wire are exactly the keys shown in this document
(`snake_case`). The server constrains identifier fields to the following
shapes:

| Kind | Constraint | Example |
| --- | --- | --- |
| `Uuid` | Hex UUID, version 1-8, case-insensitive: `^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` | `0f8fad5b-d9cb-469f-a165-70867728950e` |
| `SessionId` | `^[A-Za-z0-9][A-Za-z0-9._-]*$` | `session_42` |
| `ExchangeId` | `^[A-Za-z0-9][A-Za-z0-9._-]*$` | `turn_7` |
| `FileFingerprint` | 64 lowercase hex characters (SHA-256 hex digest) | `a3f5...` (64 chars) |
| `Email` | `^[^\s@]+@[^\s@]+\.[^\s@]+$`, at most 320 characters | `user@example.com` |
| `Base64Url` | `^[A-Za-z0-9_-]+$` | `dGhlIHF1aWNr` |
| `RawSourcePath` | `raw/<dir>/<name>.md` style paths: `^raw\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)+[A-Za-z0-9_-][A-Za-z0-9._-]*\.md$` | `raw/books/capital.md` |

### Timestamps

Fields named `created_at`, `updated_at`, `completed_at`, `expires_at`,
`last_used_at`, and `ts` are ISO 8601 date-time strings, for example
`2025-06-01T12:34:56.789Z`.

### Optional and nullable fields

The schema distinguishes three cases, and this document is precise about
which applies to every field:

- **Optional** (`optionalKey`): the key may be omitted from the JSON object.
  It is absent when not supplied. An absent key is not the same as `null`.
- **Nullable** (`NullOr`): the key is always present in the object and its
  value may be `null`.
- **Optional and nullable** (`optionalKey(NullOr(...))`): the key may be
  omitted, or present with a `null` value, or present with a value.

Where a request field has a documented default, omitting the field applies
that default. Defaults are noted per field.

### Enumerations

Fields whose values are drawn from a fixed set are documented as enumerated
strings, for example `status: "pending" | "running" | "completed" |
"failed" | "cancelled"`. Sending any other value for such a field results in
a `Validation` error.

### Success status codes

- `200 OK` - default success status.
- `201 Created` - a resource was created. Endpoints that create resources
  return `201` with the created object.
- `202 Accepted` - the request was accepted for asynchronous processing (the
  reply and compile endpoints).
- `204 No Content` - the request succeeded and there is no response body.

Endpoints marked `204` never return a body; endpoints marked `200`/`201`/`202`
return the body described in the response section.

### Authentication requirement

Every endpoint in the reference is marked with **Auth: required** or
**Auth: none**. Endpoints requiring auth accept either a JWT access token or
an API key in the `Authorization` header (see [Authentication](#authentication)).

## Authentication

### Bearer tokens

All authenticated endpoints accept the token in the standard bearer header:

```
Authorization: Bearer <token>
```

Two credential kinds are accepted, and the server distinguishes them
internally (see the `credential_kind` note in [Shares](#shares)):

1. **JWT access tokens** obtained from the code flow or passkey flow
   (below). These expire and are refreshed with the refresh token.
2. **API keys** created under `POST /v1/auth/api-keys`. API keys are opaque
   strings prefixed with `gm_` and do not expire; revoke them with
   `DELETE /v1/auth/api-keys/:key_id`.

If the header is missing, empty, or the token is not valid, the server
returns `401 Unauthorized` (for example
`{"_tag": "Unauthorized", "detail": "Invalid credentials"}`). The raw file
upload route returns `{"_tag": "Unauthorized", "detail": "Missing bearer
token"}` when the header is absent.

### Email code flow

The primary sign-in flow uses a one-time code sent by email.

#### POST /v1/auth/request-code

Auth: none.

Sends a one-time sign-in code to the given email address. The email is
normalized (trimmed and lowercased) before use. If a code was previously
issued for the same address and not yet used, it is invalidated.

Request body (`RequestCodeInput`):

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `email` | `Email` | yes | Address to send the code to. |

Response: `204 No Content`.

Errors: `422 Validation`.

Example:

```json
{ "email": "user@example.com" }
```

#### POST /v1/auth/verify-code

Auth: none.

Exchanges a code for a token pair. The first time a given email verifies a
code, a user account is created. The code is single-use and expires.

Request body (`VerifyCodeInput`):

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `email` | `Email` | yes | Address the code was sent to. |
| `code` | `string` | yes | The one-time code. |

Response: `200` with a `TokenPair`:

| Field | Type | Description |
| --- | --- | --- |
| `access_token` | `string` | JWT access token; use as the bearer token. |
| `refresh_token` | `string` | Opaque refresh token; exchange it via `/auth/refresh`. |
| `token_type` | `"bearer"` | Always `"bearer"`. |

Example:

```json
{
  "access_token": "eyJhbGciOi...",
  "refresh_token": "f7c2...",
  "token_type": "bearer"
}
```

Errors: `401 Unauthorized` (invalid or expired code), `422 Validation`.

#### POST /v1/auth/refresh

Auth: none.

Exchanges a refresh token for a new token pair. The presented refresh token
is revoked and a new one is issued (rotation).

Request body (`RefreshInput`):

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `refresh_token` | `string` | yes | A previously issued refresh token. |

Response: `200` with a `TokenPair` (same shape as above).

Errors: `401 Unauthorized` (invalid or expired refresh token), `422 Validation`.

### Passkey authentication

Passkeys follow the WebAuthn ceremony. All `Base64Url` fields are
base64url-encoded binary values.

#### POST /v1/auth/passkeys/register-options

Auth: required.

Starts passkey registration for the authenticated user.

No request body.

Response: `200` with a `PasskeyRegistrationOptions` object:

| Field | Type | Description |
| --- | --- | --- |
| `rp` | object | Relying party. `id` (optional string) and `name` (string). |
| `user` | object | `id` (Base64Url), `name` (string), `displayName` (string). |
| `challenge` | `Base64Url` | Challenge to sign. |
| `pubKeyCredParams` | array | `{alg: number, type: "public-key"}` entries. |
| `timeout` | number (optional) | Recommended ceremony timeout, in milliseconds. |
| `excludeCredentials` | array (optional) | `{id: Base64Url, type: "public-key", transports?: array}` entries already registered. |
| `authenticatorSelection` | object (optional) | `authenticatorAttachment` (`"cross-platform"` or `"platform"`), `residentKey` (`"discouraged"`, `"preferred"`, `"required"`), `requireResidentKey` (boolean), `userVerification` (`"discouraged"`, `"preferred"`, `"required"`). |
| `hints` | array (optional) | `"hybrid"`, `"security-key"`, `"client-device"`. |
| `attestation` | string (optional) | `"direct"`, `"enterprise"`, `"none"`. |
| `attestationFormats` | array (optional) | `"fido-u2f"`, `"packed"`, `"android-safetynet"`, `"android-key"`, `"tpm"`, `"apple"`, `"none"`. |
| `extensions` | object (optional) | Client extension inputs: `appid` (string), `credProps` (boolean), `hmacCreateSecret` (boolean), `minPinLength` (boolean). |

Errors: `401 Unauthorized`.

#### POST /v1/auth/passkeys/register

Auth: required.

Completes passkey registration. Sends the authenticator's response to the
server; the passkey is stored for the authenticated user.

Request body (`PasskeyRegistration`):

| Field | Type | Description |
| --- | --- | --- |
| `id` | `Base64Url` | Credential id. |
| `rawId` | `Base64Url` | Raw credential id. |
| `type` | `"public-key"` | Always `"public-key"`. |
| `name` | string (non-empty, must contain non-whitespace) | Human-readable name for the passkey. |
| `response` | object | `clientDataJSON` (Base64Url), `attestationObject` (Base64Url), `authenticatorData` (Base64Url, optional), `transports` (array, optional), `publicKeyAlgorithm` (number, optional), `publicKey` (Base64Url, optional). |
| `authenticatorAttachment` | string (optional) | `"cross-platform"` or `"platform"`. |
| `clientExtensionResults` | object | `appid` (boolean, optional), `credProps` (`{rk?: boolean}`, optional), `hmacCreateSecret` (boolean, optional). |

Response: `201 Created` with a `Passkey`:

| Field | Type | Description |
| --- | --- | --- |
| `id` | `Uuid` | Passkey id. |
| `name` | string | Display name. |
| `created_at` | ISO 8601 | Creation time. |
| `last_used_at` | ISO 8601 or `null` | Last use time (nullable). |
| `transports` | array | Subset of `"ble"`, `"cable"`, `"hybrid"`, `"internal"`, `"nfc"`, `"smart-card"`, `"usb"`. |

Errors: `422 Validation`.

#### POST /v1/auth/passkeys/options

Auth: none.

Starts passkey authentication. Returns the options to present to the
authenticator.

No request body.

Response: `200` with a `PasskeyAuthenticationOptions` object:

| Field | Type | Description |
| --- | --- | --- |
| `challenge` | `Base64Url` | Challenge to sign. |
| `timeout` | number (optional) | Recommended timeout in milliseconds. |
| `rpId` | string (optional) | Relying party id. |
| `allowCredentials` | array (optional) | `{id: Base64Url, type: "public-key", transports?: array}` entries the user may authenticate with. |
| `userVerification` | string (optional) | `"discouraged"`, `"preferred"`, `"required"`. |
| `hints` | array (optional) | `"hybrid"`, `"security-key"`, `"client-device"`. |
| `extensions` | object (optional) | Client extension inputs (same shape as registration). |

Errors: none.

#### POST /v1/auth/passkeys/verify

Auth: none.

Completes passkey authentication and returns a token pair. If the passkey
belongs to an existing user, that user is authenticated; otherwise a new
account is created and the passkey is registered.

Request body (`PasskeyAuthentication`):

| Field | Type | Description |
| --- | --- | --- |
| `id` | `Base64Url` | Credential id. |
| `rawId` | `Base64Url` | Raw credential id. |
| `type` | `"public-key"` | Always `"public-key"`. |
| `response` | object | `clientDataJSON` (Base64Url), `authenticatorData` (Base64Url), `signature` (Base64Url), `userHandle` (Base64Url, optional). |
| `authenticatorAttachment` | string (optional) | `"cross-platform"` or `"platform"`. |
| `clientExtensionResults` | object | Same shape as registration. |

Response: `200` with a `TokenPair`.

Errors: `401 Unauthorized` (signature verification failed), `422 Validation`.

#### GET /v1/auth/passkeys

Auth: required.

Lists the authenticated user's passkeys.

Response: `200` with an array of `Passkey` objects (shape above). Passkeys
are listed newest first.

Errors: `401 Unauthorized`.

#### DELETE /v1/auth/passkeys/:id

Auth: required.

Deletes a passkey.

Path parameters: `id` (`Uuid`).

Response: `204 No Content`.

Errors: `404 NotFound`, `422 Validation`.

### API keys

API keys are the recommended credential for scripts and wrapper services.
They are shown in full exactly once, at creation time.

#### POST /v1/auth/api-keys

Auth: required.

Creates an API key.

Request body (`ApiKeyCreate`):

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `label` | string | yes | A human-readable label for the key. |

Response: `201 Created` with an `ApiKeyWithSecret`:

| Field | Type | Description |
| --- | --- | --- |
| `id` | `Uuid` | Key id (used for deletion). |
| `label` | string | The label supplied at creation. |
| `created_at` | ISO 8601 | Creation time. |
| `revoked` | boolean | `false` at creation. |
| `raw_key` | string | The full key, prefixed with `gm_`. This is the only time the raw key is returned; store it securely. |

Example:

```json
{
  "id": "0f8fad5b-d9cb-469f-a165-70867728950e",
  "label": "automation",
  "created_at": "2025-06-01T12:34:56.789Z",
  "revoked": false,
  "raw_key": "gm_ab12..."
}
```

Errors: `422 Validation`.

#### GET /v1/auth/api-keys

Auth: required.

Lists the authenticated user's API keys. The `raw_key` is never included in
list responses.

Response: `200` with an array of `ApiKey` objects (`id`, `label`,
`created_at`, `revoked`), newest first.

Errors: `401 Unauthorized`.

#### DELETE /v1/auth/api-keys/:key_id

Auth: required.

Revokes an API key. Revoked keys stop working immediately.

Path parameters: `key_id` (`Uuid`).

Response: `204 No Content`.

Errors: `404 NotFound`, `422 Validation`.

### Account deletion

#### DELETE /v1/auth/me

Auth: required.

Permanently deletes the authenticated user's account, all vaults they own,
and all stored content. This cannot be undone.

Request body (`AccountDeleteRequest`):

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `confirm` | `"DELETE"` | yes | Must be the literal string `"DELETE"`. |

Response: `204 No Content`.

Errors: `404 NotFound`, `422 Validation`.

## Errors

All error responses are JSON objects with two fields:

| Field | Type | Description |
| --- | --- | --- |
| `_tag` | string | The error tag (see table below). |
| `detail` | string | A human-readable description. |

Example:

```json
{ "_tag": "NotFound", "detail": "Vault not found" }
```

The `_tag` value maps to the HTTP status code as follows:

| `_tag` | HTTP status | Meaning |
| --- | --- | --- |
| `Unauthorized` | `401` | Missing, invalid, or expired credentials. |
| `Forbidden` | `403` | The authenticated user may not perform this action (no access, wrong role, or credential kind not accepted). |
| `NotFound` | `404` | The referenced resource does not exist or is not visible to the user. |
| `BadRequest` | `400` | The request is malformed or semantically invalid. |
| `Conflict` | `409` | The request conflicts with the current state of a resource (for example, an id already in use by a different request). |
| `Validation` | `422` | Request body, query, path, or header failed schema validation. |
| `ServiceUnavailable` | `503` | A required upstream service is not available. |

Each endpoint section lists the tags that endpoint can return, using the
short names above. Two additional notes apply globally:

- Schema validation failures for path parameters produce detail
  `"Invalid path parameter"`; for query parameters
  `"Invalid query parameters"`; for request bodies `"Invalid request body"`;
  for headers `"Invalid request headers"`.
- An unexpected server fault returns `500` with body
  `{"detail": "Internal Server Error"}`. The `500` status is not part of any
  endpoint's declared error list, but can occur.

## Pagination

Endpoints that return collections accept two query parameters:

| Parameter | Type | Default | Constraint |
| --- | --- | --- | --- |
| `limit` | integer (string form) | `50` | `0 <= limit <= 200` |
| `offset` | integer (string form) | `0` | `offset >= 0` |

Both parameters are supplied as query strings; the server parses them as
integers. A `limit` above `200` is rejected with `422 Validation`.

The standard page envelope is:

```json
{
  "items": [ ... ],
  "pagination": {
    "limit": 50,
    "offset": 0,
    "total": 137
  }
}
```

| Field | Type | Description |
| --- | --- | --- |
| `items` | array | The page of resources. |
| `pagination.limit` | number | The limit applied to this page. |
| `pagination.offset` | number | The offset applied to this page. |
| `pagination.total` | number | The total number of matching resources across all pages (not just this page). |

Two collections extend the envelope:

- `GET /v1/vaults` adds a `roles` object mapping each vault id to the
  caller's role in that vault.
- `GET /v1/vaults/:vault_id/raw/sources` adds a `facets` object with facet
  counts.

Both are documented in their sections below.

## Endpoint reference

### Auth

All auth endpoints are documented in full under [Authentication](#authentication).

### Meta

#### GET /v1/health

Auth: none.

Liveness check for the versioned API surface.

Response: `200` with:

```json
{ "status": "ok" }
```

Errors: none.

In addition to the versioned endpoint above, the server exposes the same
check at two unversioned routes for load balancers and process supervisors:

- `GET /health`
- `GET /`

Both return `200` with the same `{"status": "ok"}` body.

### Refs

References are personal collections of external URLs saved by a user. They
live under `/v1/me/refs` and are scoped to the authenticated user; they are
not part of any vault. A reference resolves to a document (an article saved
from a URL). All refs endpoints require authentication.

#### POST /v1/me/refs

Auth: required.

Saves a URL as a reference. The URL is canonicalized by the server before it
is stored.

Request body (`ReferenceCreate`):

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `url` | string | yes | The URL to save. |

Response: `201 Created` with a `ReferenceDetail`:

| Field | Type | Description |
| --- | --- | --- |
| `id` | `Uuid` | Reference id. |
| `file_path` | string | The document path the reference resolves to. |
| `title` | string or `null` | Display title; `null` until set. |
| `url` | string or `null` | The canonical URL. |
| `origin` | string or `null` | Origin annotation, if any. |
| `author` | string or `null` | Author, when known. |
| `published` | string or `null` | Publication date, when known. |
| `created_at` | ISO 8601 | Creation time. |
| `updated_at` | ISO 8601 | Last update time. |

If the URL is already saved as a reference, the server returns `200` with the
existing `ReferenceDetail` instead of `201`.

Errors: `400 BadRequest`, `422 Validation`.

#### GET /v1/me/refs

Auth: required.

Lists the authenticated user's references, newest first.

Query parameters: `limit`, `offset` (see [Pagination](#pagination)).

Response: `200` with a `ReferencePage` (standard page envelope of
`ReferenceDetail`-overview objects; each item has the same fields as the
detail above).

Errors: `422 Validation`.

#### GET /v1/me/refs/doc

Auth: required.

Resolves a document path to the reference that produced it and returns the
document body.

Query parameters:

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `path` | string | yes | The document path to resolve. |

Response: `200` with a `ReferenceDocumentResponse`:

```json
{
  "reference": {
    "id": "0f8fad5b-d9cb-469f-a165-70867728950e",
    "file_path": "raw/articles/some-article.md",
    "title": "Some Article",
    "url": "https://example.com/article",
    "origin": null,
    "author": null,
    "published": null,
    "created_at": "2025-06-01T12:34:56.789Z",
    "updated_at": "2025-06-01T12:34:56.789Z"
  },
  "body": "# Some Article\n\nBody text..."
}
```

| Field | Type | Description |
| --- | --- | --- |
| `reference` | object | The `ReferenceOverview` for the resolved document. |
| `body` | string | The full document body. |

Errors: `400 BadRequest`, `404 NotFound`, `422 Validation`.

#### DELETE /v1/me/refs/:reference_id

Auth: required.

Deletes a reference.

Path parameters: `reference_id` (`Uuid`).

Response: `204 No Content`.

Errors: `400 BadRequest`, `404 NotFound`, `422 Validation`.

#### PATCH /v1/me/refs/:reference_id

Auth: required.

Updates a reference's title.

Path parameters: `reference_id` (`Uuid`).

Request body (`ReferenceUpdate`):

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `title` | string or `null` | yes | The new title. Pass `null` to clear the title back to none. |

Response: `200` with a `ReferenceDetail`.

Errors: `400 BadRequest`, `404 NotFound`, `422 Validation`.

### Vaults

Vaults are the top-level containers for knowledge. Every endpoint in this
group requires authentication. Members of a vault hold one of three roles:
`owner`, `editor`, or `viewer`.

#### GET /v1/vaults

Auth: required.

Lists the vaults the authenticated user belongs to, newest first.

Query parameters: `limit`, `offset` (see [Pagination](#pagination)).

Response: `200` with a `VaultPage`:

```json
{
  "items": [
    {
      "id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      "name": "Research",
      "owner_id": "0f8fad5b-d9cb-469f-a165-70867728950e",
      "created_at": "2025-06-01T12:34:56.789Z"
    }
  ],
  "pagination": { "limit": 50, "offset": 0, "total": 2 },
  "roles": {
    "3fa85f64-5717-4562-b3fc-2c963f66afa6": "owner",
    "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d": "viewer"
  }
}
```

Each `items` entry is a `Vault`:

| Field | Type | Description |
| --- | --- | --- |
| `id` | `Uuid` | Vault id. |
| `name` | string | Vault name. |
| `owner_id` | `Uuid` | Id of the vault owner. |
| `created_at` | ISO 8601 | Creation time. |

`roles` is a record keyed by vault id, whose values are the caller's role
(`"owner"`, `"editor"`, or `"viewer"`) in that vault. The record contains an
entry for every vault in `items`.

Errors: `422 Validation`.

#### POST /v1/vaults

Auth: required.

Creates a vault. The creator becomes the `owner`.

Request body (`VaultCreate`):

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | yes | Vault name. |
| `thematic_hint` | string | no | A short thematic description used to guide vault curation. |
| `kinds` | array of string | no | Content kinds the vault will hold. |

Response: `201 Created` with a `Vault` (shape above).

Errors: `422 Validation`.

#### POST /v1/vaults/draft-hint

Auth: required.

Drafts a thematic hint for a vault from a free-form description. Useful for
surfacing a suggested hint to the user before creating or configuring a
vault.

Request body (`DraftHintRequest`):

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `description` | string | yes | Free-form description of the vault's subject matter. |

Response: `200` with a `DraftHintResponse`:

```json
{ "thematic_hint": "20th-century political economy" }
```

Errors: `400 BadRequest`, `503 ServiceUnavailable`, `422 Validation`.

#### GET /v1/vaults/:vault_id

Auth: required.

Returns a vault's details.

Path parameters: `vault_id` (`Uuid`).

Response: `200` with a `VaultDetail` (a `Vault` plus):

| Field | Type | Description |
| --- | --- | --- |
| `role` | `"owner"` \| `"editor"` \| `"viewer"` | The caller's role in the vault. |
| `member_count` | number | Number of members. |
| `article_count` | number | Number of articles in the vault. |

Errors: `403 Forbidden`, `422 Validation`.

#### GET /v1/vaults/:vault_id/config

Auth: required.

Returns the vault's curation configuration.

Path parameters: `vault_id` (`Uuid`).

Response: `200` with a `VaultConfig`:

| Field | Type | Description |
| --- | --- | --- |
| `thematic_hint` | string | The vault's thematic hint. |
| `kinds` | array of string | Content kinds. |

Errors: `403 Forbidden`, `422 Validation`.

#### PATCH /v1/vaults/:vault_id/config

Auth: required.

Updates the vault's curation configuration. Only supplied fields are
changed.

Path parameters: `vault_id` (`Uuid`).

Request body (`VaultConfigUpdate`):

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `thematic_hint` | string | no | New thematic hint. |
| `kinds` | array of string | no | New content kinds. |

Response: `200` with the updated `VaultConfig`.

Errors: `403 Forbidden`, `422 Validation`.

#### GET /v1/vaults/:vault_id/members

Auth: required.

Lists the vault's members.

Path parameters: `vault_id` (`Uuid`).

Query parameters: `limit`, `offset` (see [Pagination](#pagination)).

Response: `200` with a `MemberPage` (standard page envelope). Each item is a
`MemberWithEmail`:

| Field | Type | Description |
| --- | --- | --- |
| `user_id` | `Uuid` | Member's user id. |
| `email` | `Email` | Member's email. |
| `role` | `"owner"` \| `"editor"` \| `"viewer"` | Member's role. |

Errors: `403 Forbidden`, `422 Validation`.

#### POST /v1/vaults/:vault_id/members

Auth: required.

Invites a user to the vault by email. The invited role defaults to `viewer`.

Path parameters: `vault_id` (`Uuid`).

Request body (`MembershipInvite`):

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `email` | `Email` | yes | Email of the user to invite. |
| `role` | `"editor"` \| `"viewer"` | no | Invited role. `owner` cannot be granted by invitation. Defaults to `"viewer"`. |

Response: `201 Created` with a `MemberWithEmail`.

Errors: `403 Forbidden`, `422 Validation`.

#### PUT /v1/vaults/:vault_id/members/:member_user_id

Auth: required.

Changes a member's role.

Path parameters: `vault_id` (`Uuid`), `member_user_id` (`Uuid`).

Request body (`MembershipUpdate`):

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `role` | `"owner"` \| `"editor"` \| `"viewer"` | yes | New role. |

Response: `200` with the updated `MemberWithEmail`.

Errors: `403 Forbidden`, `404 NotFound`, `422 Validation`.

#### DELETE /v1/vaults/:vault_id/members/:member_user_id

Auth: required.

Removes a member from the vault.

Path parameters: `vault_id` (`Uuid`), `member_user_id` (`Uuid`).

Response: `204 No Content`.

Errors: `403 Forbidden`, `404 NotFound`, `422 Validation`.

#### POST /v1/vaults/:vault_id/transfer-ownership

Auth: required.

Transfers vault ownership to another member.

Path parameters: `vault_id` (`Uuid`).

Request body (`OwnershipTransfer`):

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `new_owner_user_id` | `Uuid` | yes | User id of the new owner. |

Response: `204 No Content`.

Errors: `400 BadRequest`, `403 Forbidden`, `422 Validation`.

#### DELETE /v1/vaults/:vault_id

Auth: required.

Deletes the vault and all content in it.

Path parameters: `vault_id` (`Uuid`).

Response: `204 No Content`.

Errors: `403 Forbidden`, `404 NotFound`, `422 Validation`.

### Wiki

The wiki is the curated article layer of a vault. Articles are addressed by
`file_path` and have stable `slug`s. All wiki endpoints require
authentication.

#### GET /v1/vaults/:vault_id/wiki

Auth: required.

Lists wiki articles, with optional filtering. Articles are returned in
ascending title order (case-insensitive).

Path parameters: `vault_id` (`Uuid`).

Query parameters:

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `limit` | integer | no | Page size (see [Pagination](#pagination)). |
| `offset` | integer | no | Page offset. |
| `run` | `Uuid` | no | Restrict to articles created by the given pipeline run. |
| `contains` | string | no | Substring filter on article content. |
| `tag` | string | no | Restrict to articles with the given tag. |

Response: `200` with a `WikiArticlePage` (standard page envelope). Each item
is a `WikiArticleOverview`:

| Field | Type | Description |
| --- | --- | --- |
| `file_path` | string | Article path in the vault. |
| `title` | string | Article title. |
| `precis` | string | Short summary. |
| `updated_at` | ISO 8601 or `null` | Last update time (nullable). |
| `slug` | string | Stable slug used in links. |

Errors: `403 Forbidden`, `422 Validation`.

#### GET /v1/vaults/:vault_id/wiki/recent

Auth: required.

Lists recently updated wiki articles.

Path parameters: `vault_id` (`Uuid`).

Query parameters: `limit`, `offset` (see [Pagination](#pagination)).

Response: `200` with a `WikiArticlePage` (same item shape as above).

Errors: `403 Forbidden`, `422 Validation`.

### Sources

Sources are the raw ingested documents of a vault (files, fetched web pages,
and other origin material). All sources endpoints require authentication.

#### GET /v1/vaults/:vault_id/raw/sources

Auth: required.

Lists source documents with optional filtering and facet counts.

Path parameters: `vault_id` (`Uuid`).

Query parameters:

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `limit` | integer | no | Page size (see [Pagination](#pagination)). |
| `offset` | integer | no | Page offset. |
| `source_type` | string | no | Restrict to a source type. |
| `search` | string | no | Free-text search over sources. |
| `tag` | string | no | Restrict to sources with the given tag. |

Response: `200` with a `SourceDocumentPage`:

```json
{
  "items": [
    {
      "id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      "file_path": "raw/books/capital.md",
      "source_type": "upload",
      "title": "Capital",
      "author": "Karl Marx",
      "published_date": "1867",
      "url": null,
      "origin": "library",
      "genre": null,
      "precis": "A critique of political economy.",
      "tags": ["economics", "theory"],
      "derived_extras": {},
      "updated_at": "2025-06-01T12:34:56.789Z"
    }
  ],
  "pagination": { "limit": 50, "offset": 0, "total": 1 },
  "facets": {
    "source_types": [{ "value": "upload", "count": 1 }]
  }
}
```

Each item is a `SourceDocumentSummary`:

| Field | Type | Description |
| --- | --- | --- |
| `id` | `Uuid` | Source id. |
| `file_path` | string | Source path. |
| `source_type` | string | Type of source. |
| `title` | string or `null` | Title, when known. |
| `author` | string or `null` | Author, when known. |
| `published_date` | string or `null` | Publication date, when known. |
| `url` | string or `null` | Origin URL, when applicable. |
| `origin` | string or `null` | Origin annotation. |
| `genre` | string or `null` | Genre, when known. |
| `precis` | string or `null` | Summary, when available. |
| `tags` | array of string | Assigned tags. |
| `derived_extras` | object | Extra derived metadata. |
| `updated_at` | ISO 8601 or `null` | Last update time. |

`facets.source_types` is an array of `{value, count}` objects giving the
number of sources per `source_type` across the full result set (not just the
current page).

Errors: `403 Forbidden`, `422 Validation`.

#### GET /v1/vaults/:vault_id/raw/sources/:source_id

Auth: required.

Reads a source document and its body.

Path parameters: `vault_id` (`Uuid`), `source_id` (`Uuid`).

Response: `200` with a `DocResponse`:

```json
{
  "article": {
    "kind": "source",
    "id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    "vault_id": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
    "file_path": "raw/books/capital.md",
    "body_hash": "a3f5...",
    "source_type": "upload",
    "etag": null,
    "url": null,
    "canonical_url": null,
    "origin": null,
    "provenance_session_id": null,
    "provenance_exchange_id": null,
    "provenance_session_query": null,
    "provenance_source_doc_path": null,
    "provenance_source_anchor": null,
    "provenance_source_paragraph_index": null,
    "provenance_anchored_to": null,
    "provenance_anchored_section": null,
    "provenance_intent": null,
    "title": "Capital",
    "precis": "A critique of political economy.",
    "author": "Karl Marx",
    "published_date": "1867",
    "genre": null,
    "tags": ["economics"],
    "derived_extras": {},
    "created_at": "2025-06-01T12:34:56.789Z",
    "updated_at": "2025-06-01T12:34:56.789Z"
  },
  "body": "# Capital\n\n...",
  "archived": false,
  "superseded_by": null
}
```

`article` is a union discriminated by `kind`:

- `kind: "source"` - a `SourceDocument`. Fields as in the example above;
  the `provenance_*` fields describe how the source was captured (which
  session and exchange produced it), and are `null` when not applicable.
- `kind: "wiki"` - a `WikiArticle`, documented under [Documents](#documents).

Top-level fields:

| Field | Type | Description |
| --- | --- | --- |
| `article` | object | The article metadata. |
| `body` | string | Full document body. |
| `archived` | boolean | `true` if the document has been archived. |
| `superseded_by` | string or `null` | Path of the document that superseded this one, if any. |

Errors: `400 BadRequest`, `403 Forbidden`, `404 NotFound`, `422 Validation`.

#### DELETE /v1/vaults/:vault_id/raw/sources/:source_id

Auth: required.

Deletes a source document.

Path parameters: `vault_id` (`Uuid`), `source_id` (`Uuid`).

Response: `204 No Content`.

Errors: `400 BadRequest`, `403 Forbidden`, `404 NotFound`, `422 Validation`.

#### POST /v1/vaults/:vault_id/raw/sources/:source_id/deletion-request

Auth: required.

Requests deletion of a source document. Depending on the caller's role this
either deletes the source directly or creates a deletion proposal for review.

Path parameters: `vault_id` (`Uuid`), `source_id` (`Uuid`).

No request body.

Response: `201 Created` with a `Proposal` (shape documented under
[Proposals](#proposals)).

Errors: `400 BadRequest`, `403 Forbidden`, `404 NotFound`, `409 Conflict`,
`422 Validation`.

### Proposals

Proposals carry content changes (new articles, source deletions, and so on)
through a review workflow before they are applied to a vault. A proposal is
either `pending`, `approved`, or `rejected`. All proposals endpoints require
authentication.

#### GET /v1/vaults/:vault_id/proposals

Auth: required.

Lists proposals, newest first, optionally filtered by status.

Path parameters: `vault_id` (`Uuid`).

Query parameters:

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `limit` | integer | no | Page size (see [Pagination](#pagination)). |
| `offset` | integer | no | Page offset. |
| `status` | `"pending"` \| `"approved"` \| `"rejected"` | no | Filter by status. |

Response: `200` with a `ProposalPage` (standard page envelope). Each item is
a `ProposalOverview`:

| Field | Type | Description |
| --- | --- | --- |
| `id` | `Uuid` | Proposal id. |
| `vault_id` | `Uuid` | Vault the proposal belongs to. |
| `status` | `"pending"` \| `"approved"` \| `"rejected"` | Review status. |
| `title` | string or `null` | Proposal title (nullable). |
| `content_type` | string | Type of content the proposal carries. |
| `created_at` | ISO 8601 | Creation time. |

Errors: `403 Forbidden`, `422 Validation`.

#### POST /v1/vaults/:vault_id/proposals

Auth: required.

Creates a proposal.

Path parameters: `vault_id` (`Uuid`).

Request body (`ProposalCreate`):

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `content` | string | yes | The proposed content (markdown). |
| `content_type` | string | no | Content type. |
| `title` | string | no | Proposal title. |
| `author` | string | no | Author attribution. |

Response: `201 Created` with a `Proposal`:

| Field | Type | Description |
| --- | --- | --- |
| `id` | `Uuid` | Proposal id. |
| `vault_id` | `Uuid` | Vault id. |
| `status` | `"pending"` \| `"approved"` \| `"rejected"` | Starts as `"pending"`. |
| `title` | string or `null` | Title. |
| `content_type` | string | Content type. |
| `created_at` | ISO 8601 | Creation time. |
| `user_id` | `Uuid` | Proposing user. |
| `author` | string or `null` | Author attribution. |
| `dest_path` | string | Destination path the content would be written to. |
| `source_id` | `Uuid` | Related source document id. |

Errors: `400 BadRequest`, `403 Forbidden`, `422 Validation`.

#### GET /v1/vaults/:vault_id/proposals/:proposal_id

Auth: required.

Reads a single proposal.

Path parameters: `vault_id` (`Uuid`), `proposal_id` (`Uuid`).

Response: `200` with a `Proposal` (shape above).

Errors: `403 Forbidden`, `404 NotFound`, `422 Validation`.

#### PATCH /v1/vaults/:vault_id/proposals/:proposal_id

Auth: required.

Reviews a proposal: approves or rejects it. Approved proposals are applied
to the vault; rejected proposals are closed.

Path parameters: `vault_id` (`Uuid`), `proposal_id` (`Uuid`).

Request body (`ProposalUpdate`):

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `status` | `"approved"` \| `"rejected"` | yes | The review decision. |

Response: `200` with the updated `Proposal`.

Errors: `403 Forbidden`, `404 NotFound`, `409 Conflict`, `422 Validation`.

### Ingest

Ingest endpoints bring content into a vault: raw markdown, saved references,
user suggestions, and file batches. All ingest endpoints require
authentication.

#### POST /v1/vaults/:vault_id/ingest

Auth: required.

Ingests a raw markdown document directly into a vault.

Path parameters: `vault_id` (`Uuid`).

Request body (`RawSource`):

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `content` | string | yes | The markdown content. |
| `dest` | `RawSourcePath` | yes | Destination path. Must match `raw/<dir>/<name>.md`. |
| `origin` | string | no | Origin annotation. |

Response: `201 Created` with an `IngestedDocument`:

| Field | Type | Description |
| --- | --- | --- |
| `id` | `Uuid` | The source document id. |
| `file_path` | string | The path the document was written to. |

Errors: `403 Forbidden`, `422 Validation`.

#### POST /v1/vaults/:vault_id/ingest/reference

Auth: required.

Promotes a saved personal reference into the vault as a source document.

Path parameters: `vault_id` (`Uuid`).

Request body (`ReferencePromote`):

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `path` | string | yes | The reference's document path (as returned by `GET /v1/me/refs/doc` or the reference list). |

Response: `201 Created` with an `IngestedDocument`. If the reference has
already been promoted into this vault, the server returns `200` with the
existing `IngestedDocument` instead.

Errors: `400 BadRequest`, `403 Forbidden`, `404 NotFound`, `422 Validation`.

#### POST /v1/vaults/:vault_id/ingest/user-suggestion

Auth: required.

Ingests a reader's suggestion about a document in the vault (a disagreement,
correction, addition, or restructuring note). The server attaches the
suggestion to the relevant source.

Path parameters: `vault_id` (`Uuid`).

Request body (`UserSuggestion`):

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `body` | string | yes | The suggestion text. |
| `intent` | `"disagree"` \| `"correct"` \| `"add_context"` \| `"restructure"` | yes | What kind of suggestion this is. |
| `anchored_to` | string | no | Document the suggestion is anchored to. Defaults to `""`. |
| `anchored_section` | string | no | Section within the document. Defaults to `""`. |

Response: `201 Created` with a `UserSuggestionResult`:

| Field | Type | Description |
| --- | --- | --- |
| `id` | `Uuid` | The affected document id. |
| `file_path` | string | The affected document path. |
| `mode` | `"ingested"` \| `"proposed"` | `"ingested"` when the suggestion was applied directly; `"proposed"` when it was turned into a proposal. |

Errors: `400 BadRequest`, `403 Forbidden`, `422 Validation`.

#### POST /v1/vaults/:vault_id/file-ingests/check-dupes

Auth: required.

Checks which file hashes are already present in the vault. Use this before
uploading a batch to skip files the vault already has.

Path parameters: `vault_id` (`Uuid`).

Request body (`CheckDupesRequest`):

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `client_hashes` | array of `FileFingerprint` | yes | Hashes to check. |

Response: `200` with a `CheckDupesResponse`:

```json
{ "existing": ["a3f5...", "b7c9..."] }
```

`existing` lists the subset of `client_hashes` already stored in the vault.

Errors: `403 Forbidden`, `422 Validation`.

#### POST /v1/vaults/:vault_id/file-ingests

Auth: required.

Creates a file ingest batch. The client supplies a batch id (for
idempotency) and a manifest of files. After creation, each file is uploaded
to the raw upload route (see [Raw file upload route](#raw-file-upload-route)),
then the batch is committed.

Path parameters: `vault_id` (`Uuid`).

Request body (`FileIngestBatchCreate`):

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `batch_id` | `Uuid` | yes | Client-chosen batch id. |
| `files` | array | yes | File manifest entries, each: `name` (non-empty string), `size` (non-negative integer), `hash` (`FileFingerprint`, the SHA-256 of the file bytes), `mimetype` (string, optional). |

Response: `201 Created` with a `FileIngestBatch`:

| Field | Type | Description |
| --- | --- | --- |
| `id` | `Uuid` | Batch id (equals the supplied `batch_id`). |
| `vault_id` | `Uuid` | Vault id. |
| `created_by` | `Uuid` | Creating user. |
| `status` | `"uploading"` \| `"processing"` \| `"completed"` \| `"failed"` \| `"cancelled"` | Batch lifecycle status. |
| `error` | string or `null` | Error detail when failed. |
| `expires_at` | ISO 8601 | Time after which an uncommitted batch expires. |
| `files` | array | Per-file entries: `name`, `size`, `hash`, `mimetype`, `status` (`"pending"` \| `"uploaded"` \| `"processing"` \| `"completed"` \| `"failed"` \| `"cancelled"`), `error` (string or `null`). |
| `targets` | array | Upload targets, one per file: either `{"hash": ..., "transport": "api"}` (upload through the raw API route) or `{"hash": ..., "transport": "presigned", "url": "..."}` (upload to the given URL directly). |

Errors: `400 BadRequest`, `403 Forbidden`, `409 Conflict`, `422 Validation`.

#### GET /v1/file-ingests/:batch_id

Auth: required.

Reads a file ingest batch by id. The batch may belong to any vault the user
can access.

Path parameters: `batch_id` (`Uuid`).

Response: `200` with a `FileIngestBatch` (shape above).

Errors: `403 Forbidden`, `404 NotFound`, `422 Validation`.

#### POST /v1/file-ingests/:batch_id/resume

Auth: required.

Resumes an expired or interrupted batch so its pending files can be
uploaded again.

Path parameters: `batch_id` (`Uuid`).

No request body.

Response: `200` with the refreshed `FileIngestBatch`.

Errors: `400 BadRequest`, `403 Forbidden`, `404 NotFound`, `422 Validation`.

#### POST /v1/file-ingests/:batch_id/files/:hash/complete

Auth: required.

Acknowledges that a file with the given hash has been uploaded. This is
required after uploading via a presigned target (`transport: "presigned"`)
so the server records the upload as complete. Files uploaded through the raw
API route are acknowledged by the upload itself.

Path parameters: `batch_id` (`Uuid`), `hash` (`FileFingerprint`).

No request body.

Response: `204 No Content`.

Errors: `400 BadRequest`, `403 Forbidden`, `404 NotFound`, `422 Validation`.

#### POST /v1/file-ingests/:batch_id/commit

Auth: required.

Commits a fully uploaded batch and starts processing. The batch becomes a
pipeline job; poll or stream it through the jobs endpoints.

Path parameters: `batch_id` (`Uuid`).

No request body.

Response: `200` with a `JobResponse` (shape documented under
[Jobs](#jobs)).

Errors: `400 BadRequest`, `403 Forbidden`, `404 NotFound`, `422 Validation`.

#### Raw file upload route

##### POST /v1/file-ingests/:batch_id/files/:hash

Auth: required.

Uploads the raw bytes of one file in a batch. This route is served directly
by the HTTP layer and accepts `multipart/form-data` rather than JSON. Use it
only for files whose target in the batch has `transport: "api"`; files with a
`presigned` target are uploaded to their `url` and then acknowledged with the
`/complete` route. Only the user who created the batch may upload into it.
Uploading a file that is already marked `uploaded` succeeds without effect.

Path parameters:

| Parameter | Type | Description |
| --- | --- | --- |
| `batch_id` | `Uuid` | The batch to upload into. |
| `hash` | `FileFingerprint` | The file's SHA-256 hex digest; must match the manifest entry. |

Headers: `Authorization: Bearer <token>`.

Body: `multipart/form-data` with exactly one file part:

| Part | Value |
| --- | --- |
| `file` | The file content. The part must have a filename. |

The filename and content type are read from the part. The uploaded bytes are
verified against the manifest: the content hash must match the `hash` path
parameter and the manifest entry for that hash, otherwise the upload is
rejected.

Response: `204 No Content` on success.

Errors:

| Status | Tag | Detail examples |
| --- | --- | --- |
| `400` | `BadRequest` | `"Invalid multipart upload"`, `"Uploaded file must have a filename"`, `"Uploaded file does not match its manifest"`, `"File ingest is <status>"` (batch is no longer uploading), `"Server-mediated upload is unavailable for this storage backend"` (the batch's target for this file is `presigned`, not `api`) |
| `401` | `Unauthorized` | `"Missing bearer token"`, `"Invalid credentials"` |
| `403` | `Forbidden` | Caller is not the vault owner who created the batch. |
| `404` | `NotFound` | `"File ingest not found"`, `"File is not in this ingest manifest"` |
| `422` | `Validation` | `"Invalid path parameter"` (batch id is not a UUID or hash is not a 64-character hex digest). |

Example using curl:

```
curl -sS -X POST "$BASE/v1/file-ingests/$BATCH/files/$HASH" \
  -H "Authorization: Bearer $API_KEY" \
  -F "file=@capital.md;type=text/markdown"
```

### Jobs

A job is a pipeline run that processes content for a vault (ingesting a URL,
processing a committed file batch, or compiling the wiki). Jobs are
long-running; clients poll the job object or subscribe to the job stream. All
jobs endpoints require authentication.

#### POST /v1/vaults/:vault_id/jobs/url

Auth: required.

Starts a job that fetches a URL and ingests it into the vault. The client
supplies a job id for idempotency.

Path parameters: `vault_id` (`Uuid`).

Request body (`URLSource`):

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `job_id` | `Uuid` | yes | Client-chosen job id. |
| `url` | string | yes | The URL to fetch and ingest. Canonicalized by the server. |
| `origin` | string | no | Origin annotation. |

Response: `201 Created` with a `JobResponse`:

| Field | Type | Description |
| --- | --- | --- |
| `id` | `Uuid` | Job id. |
| `vault_id` | `Uuid` | Vault id. |
| `trigger` | `"staged_files"` \| `"url"` \| `"manual"` | How the job was started. |
| `status` | `"pending"` \| `"running"` \| `"completed"` \| `"failed"` \| `"cancelled"` | Job lifecycle status. |
| `current_phase` | string | Name of the current pipeline phase. |
| `phase_status` | string | Status of the current phase. |
| `progress_steps` | array | Per-step progress entries: `key`, `label`, `status` (`"pending"` \| `"running"` \| `"completed"` \| `"failed"`), `done` (number or `null`), `total` (number or `null`), `detail` (string). |
| `error` | string or `null` | Error detail when failed. |
| `created_at` | ISO 8601 | Creation time. |
| `updated_at` | ISO 8601 | Last update time. |
| `completed_at` | ISO 8601 or `null` | Completion time. |
| `stream_url` | string | Relative URL of the job's event stream (`/v1/vaults/:vault_id/jobs/:job_id/stream`). |

Errors: `400 BadRequest`, `403 Forbidden`, `422 Validation`.

#### POST /v1/vaults/:vault_id/jobs/:job_id/retry

Auth: required.

Retries a failed URL job. Supply a new job id in the body; the new job
re-runs the original URL.

Path parameters: `vault_id` (`Uuid`), `job_id` (`Uuid`) - the failed job.

Request body (`CompileRequest`):

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `job_id` | `Uuid` | yes | The new job id for the retry. |

Response: `201 Created` with a `JobResponse` for the new job.

Errors: `400 BadRequest`, `403 Forbidden`, `404 NotFound`, `422 Validation`.

#### GET /v1/vaults/:vault_id/jobs

Auth: required.

Lists jobs for a vault, newest first, optionally filtered by status.

Path parameters: `vault_id` (`Uuid`).

Query parameters:

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `limit` | integer | no | Page size (see [Pagination](#pagination)). |
| `offset` | integer | no | Page offset. |
| `status` | `"active"` \| `"pending"` \| `"running"` \| `"completed"` \| `"failed"` \| `"cancelled"` | no | Filter by status. `"active"` selects pending and running jobs. |

Response: `200` with a `JobPage` (standard page envelope of `JobResponse`
objects).

Errors: `403 Forbidden`, `422 Validation`.

#### GET /v1/vaults/:vault_id/jobs/:job_id

Auth: required.

Reads a single job.

Path parameters: `vault_id` (`Uuid`), `job_id` (`Uuid`).

Response: `200` with a `JobResponse`.

Errors: `403 Forbidden`, `404 NotFound`, `422 Validation`.

#### GET /v1/vaults/:vault_id/jobs/:job_id/stream

Auth: required.

Streams job progress as server-sent events. The stream stays open until the
job reaches a terminal status.

Path parameters: `vault_id` (`Uuid`), `job_id` (`Uuid`).

Response: `200` with content type `text/event-stream`. The server also sets
`Cache-Control: no-cache`, `Connection: keep-alive`, and
`X-Accel-Buffering: no` on stream responses.

Events:

| Event | `data` | Description |
| --- | --- | --- |
| `connected` | `{"id": "<job_id>"}` | Sent once when the stream opens. |
| `message` | JSON `JobProgressSnapshot` | Sent whenever the job's progress changes. |
| `done` | `{"id": "<job_id>"}` | Sent once when the job reaches `completed` or `failed`; the stream then closes. |

The `message` payload is a `JobProgressSnapshot`:

| Field | Type | Description |
| --- | --- | --- |
| `id` | `Uuid` | Job id. |
| `vault_id` | `Uuid` | Vault id. |
| `trigger` | `"staged_files"` \| `"url"` \| `"manual"` | Job trigger. |
| `job_status` | `"pending"` \| `"running"` \| `"completed"` \| `"failed"` \| `"cancelled"` | Job status. |
| `phase` | string | Current phase name. |
| `phase_status` | string | Current phase status. |
| `steps` | array | `PipelineProgressStep` entries (same shape as `progress_steps` in `JobResponse`). |
| `error` | string | Present only when the job failed. |
| `updated_at` | ISO 8601 or `null` | Last update time. |
| `completed_at` | ISO 8601 or `null` | Completion time. |

Raw wire format:

```
event: connected
data: {"id":"3fa85f64-5717-4562-b3fc-2c963f66afa6"}

event: message
data: {"id":"3fa85f64-...","vault_id":"...","trigger":"url","job_status":"running","phase":"fetch","phase_status":"running","steps":[...],"updated_at":"...","completed_at":null}

event: done
data: {"id":"3fa85f64-5717-4562-b3fc-2c963f66afa6"}
```

Keepalives: when nothing has changed for 30 seconds the server emits a
keepalive frame. On the wire it appears as an SSE comment line
(`: heartbeat`). Clients must ignore lines beginning with `:`.

Errors: `403 Forbidden`, `404 NotFound`, `422 Validation`.

### Compile

Compile endpoints drive the pipeline that assembles a vault's wiki from its
sources. Both endpoints require authentication and vault ownership (the
`owner` role).

#### POST /v1/vaults/:vault_id/compile

Auth: required (vault owner).

Requests a compile of the vault's wiki. The client supplies a job id for the
compile run.

Path parameters: `vault_id` (`Uuid`).

Request body (`CompileRequest`):

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `job_id` | `Uuid` | yes | Client-chosen id for the compile run. |

Response: `202 Accepted` with a `JobResponse` whose `trigger` is `"manual"`.
Track progress through the jobs endpoints, or stream it with
`GET /v1/vaults/:vault_id/jobs/:job_id/stream`.

Errors: `403 Forbidden`, `503 ServiceUnavailable`, `422 Validation`.

#### POST /v1/vaults/:vault_id/compile/:run_id/cancel

Auth: required (vault owner).

Cancels a compile run.

Path parameters: `vault_id` (`Uuid`), `run_id` (`Uuid`).

No request body.

Response: `204 No Content`.

Errors: `403 Forbidden`, `422 Validation`.

### Lint

#### GET /v1/vaults/:vault_id/lint

Auth: required.

Returns the vault's wiki lint report: orphaned articles, dirty topics, and
unmentioned links.

Path parameters: `vault_id` (`Uuid`).

Response: `200` with a `LintReport`:

| Field | Type | Description |
| --- | --- | --- |
| `orphans` | array | `WikiArticleOverview` entries that are not linked from any other article. |
| `dirty_topics` | array of `Uuid` | Topic ids flagged as dirty (needing recompilation). |
| `unmentioned_links` | array | `{source_slug, source_title, target_slug, target_title}` entries: links that exist in article bodies but are not registered in the link graph. |

Errors: `403 Forbidden`, `422 Validation`.

### Costs

Cost endpoints report usage aggregates for the authenticated user.
All costs endpoints require authentication.

#### GET /v1/costs

Auth: required.

Returns cost aggregates across all of the user's vaults.

Query parameters:

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `since` | date string | no | Restrict to events on or after this date. |
| `until` | date string | no | Restrict to events before this date. |

Response: `200` with a `CostAggregate`:

```json
{
  "total_usd": "12.34",
  "event_count": 1287,
  "by_vault": [
    { "key": "3fa85f64-5717-4562-b3fc-2c963f66afa6", "total_usd": "8.10", "event_count": 900 }
  ],
  "by_event_type": [
    { "key": "generation", "total_usd": "11.00", "event_count": 1000 }
  ]
}
```

| Field | Type | Description |
| --- | --- | --- |
| `total_usd` | string | Total cost in US dollars (string to preserve precision). |
| `event_count` | number | Total number of costed events. |
| `by_vault` | array | `CostBreakdown` entries (`key`, `total_usd`, `event_count`) per vault. |
| `by_event_type` | array | `CostBreakdown` entries per event type. |

Errors: `422 Validation`.

#### GET /v1/vaults/:vault_id/costs

Auth: required.

Returns cost aggregates for a single vault.

Path parameters: `vault_id` (`Uuid`).

Query parameters: `since`, `until` (as above).

Response: `200` with a `CostAggregate`.

Errors: `403 Forbidden`, `422 Validation`.

### Documents

Document endpoints read content by path: articles (wiki or source), chunk
ranges, and link graphs. All documents endpoints require authentication.

#### GET /v1/vaults/:vault_id/doc

Auth: required.

Resolves a document path to its article metadata and body. This is the
general-purpose document reader; it serves both wiki articles and source
documents.

Path parameters: `vault_id` (`Uuid`).

Query parameters:

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `path` | string | yes | The document path to resolve. |

Response: `200` with a `DocResponse` (shape documented under
[Sources](#get-v1vaultsvault_idrawsourcessource_id)). The `article` union
also includes wiki articles:

| Field | Type | Description |
| --- | --- | --- |
| `kind` | `"wiki"` | Discriminator for wiki articles. |
| `id` | `Uuid` | Article id. |
| `vault_id` | `Uuid` | Vault id. |
| `topic_id` | `Uuid` | Topic id the article belongs to. |
| `file_path` | string | Article path. |
| `body_hash` | string | Hash of the article body. |
| `title` | string | Article title. |
| `precis` | string | Summary. |
| `tags` | array of string | Assigned tags. |
| `created_at` | ISO 8601 or `null` | Creation time. |
| `updated_at` | ISO 8601 or `null` | Last update time. |
| `slug` | string | Stable slug. |

Errors: `400 BadRequest`, `403 Forbidden`, `404 NotFound`, `422 Validation`.

#### GET /v1/vaults/:vault_id/chunks

Auth: required.

Reads the chunk range of a document. Documents are split into numbered
chunks; this endpoint returns a contiguous slice.

Path parameters: `vault_id` (`Uuid`).

Query parameters:

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `path` | string | yes | Document path. |
| `start` | integer (string form) | yes | First chunk index (inclusive). |
| `end` | integer (string form) | yes | Last chunk index (inclusive). |

Response: `200` with an array of `Chunk`:

| Field | Type | Description |
| --- | --- | --- |
| `path` | string | Document path. |
| `chunk_index` | number | Chunk position. |
| `heading` | string | Chunk heading. |
| `body` | string | Chunk text. |
| `content_hash` | string | Hash of the chunk content. |

Errors: `403 Forbidden`, `422 Validation`.

#### GET /v1/vaults/:vault_id/links

Auth: required.

Reads the link graph around a document.

Path parameters: `vault_id` (`Uuid`).

Query parameters:

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `path` | string | yes | Document path. |

Response: `200` with a `LinkedArticles`:

| Field | Type | Description |
| --- | --- | --- |
| `outgoing` | array of `WikiArticleOverview` | Articles this document links to. |
| `incoming` | array of `WikiArticleOverview` | Articles linking to this document. |
| `related` | array of `WikiArticleOverview` | Related articles. |

Errors: `403 Forbidden`, `404 NotFound`, `422 Validation`.

### Sessions

Sessions record a conversation's history for a vault: exchanges (a question
and its answer) and BTWs (commentary anchored to a quote from a source
document, with its own follow-up exchanges).

The sessions group is read-oriented. Over HTTP you can:

- promote an exchange to a source document,
- list sessions,
- list sessions by origin document,
- read a session's events,
- read a session's markdown export.

There is no HTTP endpoint to create or directly modify a session. New
sessions are created implicitly when you create a reply of kind `exchange`
with a `create` block (see [Creating replies](#post-v1vaultsvault_idreplies)),
and exchanges and BTWs are appended to sessions the same way, by creating
replies with a `session_id`. All sessions endpoints require authentication.

#### POST /v1/vaults/:vault_id/sessions/:session_id/exchanges/:exchange_id/promote

Auth: required (vault `editor` or `owner`).

Promotes a session exchange into the vault's content. Owners promote the
exchange into an ingested source document directly; editors without owner
role create a proposal instead.

Path parameters:

| Parameter | Type | Description |
| --- | --- | --- |
| `vault_id` | `Uuid` | Vault id. |
| `session_id` | `SessionId` | Session id. |
| `exchange_id` | `ExchangeId` | The exchange to promote. |

No request body.

Response: `201 Created` with a `PromoteExchangeResponse`:

| Field | Type | Description |
| --- | --- | --- |
| `mode` | `"ingested"` \| `"proposed"` | `"ingested"` when written as a source document; `"proposed"` when a proposal was created. |
| `path` | string | The resulting document or proposal path. |
| `title` | string or `null` | Title of the promoted content. |
| `document_id` | `Uuid` or `null` | Source document id when `mode` is `"ingested"`. |
| `proposal_id` | `Uuid` or `null` | Proposal id when `mode` is `"proposed"`. |

Errors: `400 BadRequest` (the exchange has no answer yet), `403 Forbidden`,
`404 NotFound`, `422 Validation`.

#### GET /v1/vaults/:vault_id/sessions

Auth: required.

Lists sessions, most recently updated first.

Path parameters: `vault_id` (`Uuid`).

Query parameters: `limit`, `offset` (see [Pagination](#pagination)).

Response: `200` with a `SessionPage` (standard page envelope). Each item is a
`SessionOverview`:

| Field | Type | Description |
| --- | --- | --- |
| `id` | `SessionId` | Session id. |
| `query` | string | The first exchange's question. |
| `created_at` | ISO 8601 | Creation time. |
| `updated_at` | ISO 8601 | Last update time. |
| `user_id` | `Uuid` | Owner of the session. |
| `origin` | `SessionOrigin` or `null` | The document the session originated from, if any. |
| `origin_title` | string or `null` | The current title of the origin document, resolved at read time; `null` when the origin document cannot be resolved. |

`SessionOrigin`:

| Field | Type | Description |
| --- | --- | --- |
| `doc_path` | string | Path of the origin document. |
| `origin_scope` | `"vault"` \| `"personal"` | Defaults to `"vault"`. |
| `anchor` | string or `null` | Anchored quote, when the session started from a highlight. |
| `paragraph` | string or `null` | Anchored paragraph text. |
| `paragraph_index` | number or `null` | Anchored paragraph index. |

Errors: `403 Forbidden`, `422 Validation`.

#### GET /v1/vaults/:vault_id/sessions/by-origin

Auth: required.

Lists sessions that originated from a given document.

Path parameters: `vault_id` (`Uuid`).

Query parameters:

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `doc_path` | string | yes | The origin document path. |

Response: `200` with an array of `OriginSessionDetail`:

| Field | Type | Description |
| --- | --- | --- |
| `session` | `SessionOverview` | The session. |
| `events` | array of `SessionEvent` | The session's events (shape below). |

Errors: `403 Forbidden`, `422 Validation`.

#### GET /v1/vaults/:vault_id/sessions/:session_id

Auth: required.

Reads a session and all of its events.

Path parameters: `vault_id` (`Uuid`), `session_id` (`SessionId`).

Response: `200` with a `SessionResponse`:

| Field | Type | Description |
| --- | --- | --- |
| `id` | `SessionId` | Session id. |
| `events` | array of `SessionEvent` | All events, in order. |
| `origin_title` | string or `null` | Current origin document title (as in `SessionOverview`). |

`SessionEvent` is a union discriminated by `type`:

**`type: "meta"`** - the session's opening event.

| Field | Type | Description |
| --- | --- | --- |
| `type` | `"meta"` | Discriminator. |
| `id` | string | Session id. |
| `query` | string | Opening question. |
| `ts` | ISO 8601 | Timestamp. |
| `user_id` | string | User id. |
| `origin` | `SessionOrigin` or `null` | Origin document. |

**`type: "exchange"`** - a question and its answer.

| Field | Type | Description |
| --- | --- | --- |
| `type` | `"exchange"` | Discriminator. |
| `exId` | string | Exchange id. |
| `reply_id` | `Uuid` | The reply that produced this exchange (optional). |
| `query` | string | The question. |
| `thinking` | array | `ThinkingBlock` entries (optional). |
| `answer` | string | The answer (optional). |
| `ts` | ISO 8601 | Timestamp. |

**`type: "btw"`** - commentary anchored to a quote.

| Field | Type | Description |
| --- | --- | --- |
| `type` | `"btw"` | Discriminator. |
| `exId` | string | Exchange id of the BTW. |
| `reply_id` | `Uuid` | The reply that produced this BTW (optional). |
| `quote` | string | The quoted passage. |
| `blockOffset` | number | Offset of the quoted block (optional). |
| `context` | string | Surrounding context (optional). |
| `exchanges` | array | Follow-up `BtwExchange` entries: `query` (string), `thinking` (array, optional), `answer` (string, optional). |
| `ts` | ISO 8601 | Timestamp. |

`ThinkingBlock` (used by exchange events and BTW exchanges):

| Field | Type | Description |
| --- | --- | --- |
| `sources` | array | `ThinkingSource` entries (optional). |

`ThinkingSource`:

| Field | Type | Description |
| --- | --- | --- |
| `label` | string | Display label. |
| `type` | `"article"` \| `"raw"` \| `"search"` \| `"query"` \| `"links"` | Source kind. |
| `document_id` | `Uuid` or `null` | Referenced document, when applicable. |
| `title` | string or `null` | Title. |
| `scope` | `"kb"` \| `"web"` or `null` | Search scope. |
| `path` | string or `null` | Document path. |
| `thinking` | string or `null` | Notes about the source. |
| `ranges` | array | `{start, end}` chunk ranges (optional). |
| `full` | boolean | Whether the full document was used (optional). |

Errors: `403 Forbidden`, `404 NotFound`, `422 Validation`.

#### GET /v1/vaults/:vault_id/sessions/:session_id/markdown

Auth: required.

Exports a session as markdown.

Path parameters: `vault_id` (`Uuid`), `session_id` (`SessionId`).

Response: `200` with content type `text/markdown` and the rendered session
as the body.

Errors: `403 Forbidden`, `404 NotFound`, `422 Validation`.

### Replies

Replies are the unit of work for querying a vault's knowledge base. There is
no non-streaming query endpoint: to ask a question you create a reply, then
consume its event stream until it finishes.

All replies endpoints require authentication.

#### POST /v1/vaults/:vault_id/replies

Auth: required.

Creates a reply. The request is a union with a `kind` discriminator. The
server accepts the reply immediately (`202`) and starts processing it in the
background; results are delivered over the reply's event stream.

Path parameters: `vault_id` (`Uuid`).

Common fields shared by every variant:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `kind` | `"exchange"` \| `"btw"` \| `"ephemeral"` | yes | Discriminator selecting the variant below. |
| `reply_id` | `Uuid` | yes | Client-chosen id for the reply. Used for idempotency: submitting the same `reply_id` with an identical request returns the existing reply (with its `session_id`) instead of creating a new one. Submitting the same `reply_id` with a different request returns `409 Conflict`. |
| `question` | string | yes | The question to answer. |
| `mode` | `"query"` \| `"btw"` | no | Query mode. `"query"` answers against the knowledge base; `"btw"` answers in the shorter aside style used for questions asked about a passage. Defaults to `"query"`. |
| `model` | string | no | The model to use for this reply. When omitted, the vault default is used. |
| `origin_path` | string | no | Path of the document the question is about. |
| `origin_scope` | `"vault"` \| `"personal"` | no | Whether the origin document is vault content or the user's personal documents. Defaults to `"vault"`. |
| `history` | array | no | Client-assembled prior turns, each `{role: "user" \| "assistant", content: string}`. Supplied as context for this reply. Defaults to `[]`. |
| `extra_instructions` | string | no | Additional instructions for how to answer. |

**Variant 1 - `kind: "exchange"` with an existing session**:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `exchange_id` | `ExchangeId` | yes | Client-chosen id for this turn within the session. |
| `session_id` | `SessionId` | yes | Session to append the exchange to. |

**Variant 2 - `kind: "exchange"` creating a new session**:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `exchange_id` | `ExchangeId` | yes | Client-chosen id for this turn. |
| `create` | object | yes | Session creation: `idempotency_key` (string; sessions with the same key for the same user and vault are reused), `origin_scope` (`"vault"` \| `"personal"`, default `"vault"`), and `origin` (a `SessionOrigin`, optional, describing the origin document). |

**Variant 3 - `kind: "btw"`**:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `session_id` | `SessionId` | yes | Session to append the BTW to. |
| `btw` | object | yes | BTW data: `quote` (string), `blockOffset` (number, default `-1`), `context` (string, default `""`), `exchangeId` (`ExchangeId`), and `exchanges` (non-empty array of `BtwExchange` entries: `query`, `thinking` (array, optional), `answer` (string, optional)). |

**Variant 4 - `kind: "ephemeral"`**:

A standalone question with no session. No additional fields beyond the
common set. The resulting reply has `session_id: null`.

Response: `202 Accepted` with a `CreateReplyResponse`:

| Field | Type | Description |
| --- | --- | --- |
| `reply_id` | `Uuid` | The reply id (echoes the submitted `reply_id`). |
| `session_id` | `SessionId` or `null` | The session the reply belongs to. `null` for ephemeral replies. |

Example (ephemeral):

```json
{
  "kind": "ephemeral",
  "reply_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "question": "Summarize the vault's stance on labor theory",
  "mode": "query",
  "history": [],
  "origin_path": "wiki/value.md",
  "origin_scope": "vault"
}
```

Example (new session):

```json
{
  "kind": "exchange",
  "reply_id": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
  "exchange_id": "turn_1",
  "question": "What does this document argue?",
  "create": {
    "idempotency_key": "session-for-capital",
    "origin_scope": "vault",
    "origin": {
      "doc_path": "raw/books/capital.md",
      "origin_scope": "vault",
      "anchor": null,
      "paragraph": null,
      "paragraph_index": null
    }
  }
}
```

Example (append to a session):

```json
{
  "kind": "exchange",
  "reply_id": "1f0fad5b-d9cb-469f-a165-70867728950e",
  "exchange_id": "turn_2",
  "session_id": "session_42",
  "question": "And the falling rate of profit?",
  "history": [
    { "role": "user", "content": "What does this document argue?" },
    { "role": "assistant", "content": "It argues..." }
  ]
}
```

Errors: `409 Conflict` (reply id already used by a different request),
`403 Forbidden`, `404 NotFound`, `503 ServiceUnavailable`, `422 Validation`.

#### POST /v1/vaults/:vault_id/replies/:reply_id/retry

Auth: required.

Retries a failed reply. Only replies in the `failed` status can be retried,
and the retry must use a new `reply_id`. The retried reply re-runs with the
original request (including session membership).

Path parameters: `vault_id` (`Uuid`), `reply_id` (`Uuid`) - the failed reply.

Request body (`RetryReplyRequest`):

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `reply_id` | `Uuid` | yes | The new reply id for the retry. Must differ from the failed reply's id. |

Response: `202 Accepted` with a `CreateReplyResponse` for the new reply.

Errors: `400 BadRequest` (reply is not failed, or retry id equals the
original), `409 Conflict`, `403 Forbidden`, `404 NotFound`,
`503 ServiceUnavailable`, `422 Validation`.

#### GET /v1/vaults/:vault_id/replies/:reply_id/stream

Auth: required.

Streams the reply's state as server-sent events. The stream opens
immediately and stays open until the reply reaches a terminal status
(`completed` or `failed`).

Path parameters: `vault_id` (`Uuid`), `reply_id` (`Uuid`).

Response: `200` with content type `text/event-stream`. As with job streams,
the server sets `Cache-Control: no-cache`, `Connection: keep-alive`, and
`X-Accel-Buffering: no`.

Events:

| Event | `data` | Description |
| --- | --- | --- |
| `connected` | `{"id": "<reply_id>"}` | Sent once when the stream opens. |
| `message` | JSON `ReplySnapshot` | Sent whenever the reply's state changes. |
| `done` | `{"id": "<reply_id>"}` | Sent once when the reply reaches `completed` or `failed`; the stream then closes. |

The `message` payload is a `ReplySnapshot`:

| Field | Type | Description |
| --- | --- | --- |
| `reply_id` | `Uuid` | Reply id. |
| `session_id` | `SessionId` or `null` | Session the reply belongs to; `null` for ephemeral replies. |
| `kind` | `"exchange"` \| `"btw"` \| `"ephemeral"` | Reply kind. |
| `status` | `"running"` \| `"completed"` \| `"failed"` | Reply status. |
| `answer` | string | The answer text (may be partial while running). |
| `sources` | array | `ReplySource` entries: the `ThinkingSource` fields plus an optional `pending` boolean. |
| `error` | string or `null` | Error detail when failed. |
| `version` | number | Monotonic revision number of the snapshot. |
| `created_at` | ISO 8601 | Creation time. |
| `updated_at` | ISO 8601 | Last update time. |

Example message:

```json
{
  "reply_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "session_id": null,
  "kind": "ephemeral",
  "status": "completed",
  "answer": "The labor theory of value holds that...",
  "sources": [
    {
      "type": "article",
      "document_id": "0f8fad5b-d9cb-469f-a165-70867728950e",
      "path": "wiki/value.md",
      "title": "Value",
      "label": "wiki/value.md",
      "scope": null,
      "thinking": null,
      "full": true,
      "ranges": [{ "start": 0, "end": 3 }]
    }
  ],
  "error": null,
  "version": 4,
  "created_at": "2025-06-01T12:34:56.789Z",
  "updated_at": "2025-06-01T12:34:58.789Z"
}
```

Keepalives: as with job streams, when the reply state has not changed for 30
seconds the server emits a keepalive frame that appears on the wire as an SSE
comment (`: heartbeat`). Ignore lines beginning with `:`.

Errors: `403 Forbidden`, `404 NotFound`, `422 Validation`.

### Shares

Shares make a session or reference readable by anyone with the share link,
without authentication. All share-management endpoints require
authentication.

#### POST /v1/shares

Auth: required (session credential).

Creates a share for a session or reference. Share creation requires a JWT
session credential; API keys cannot create shares (the server returns
`403 Forbidden`).

Request body (`ShareCreate`):

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `subject_kind` | `"session"` \| `"reference"` | yes | What to share. |
| `subject_id` | `Uuid` | yes | Id of the session or reference to share. |
| `include_annotations` | boolean | no | Whether to include annotated passages in the shared view. |
| `expires_at` | ISO 8601 | no | Expiry time for the share. |

Response: `201 Created` with a `ShareCreateResult`:

```json
{
  "share": {
    "id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    "token": "f7c2ab90",
    "subject_kind": "session",
    "subject_id": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
    "created_by": "0f8fad5b-d9cb-469f-a165-70867728950e",
    "include_annotations": true,
    "created_at": "2025-06-01T12:34:56.789Z",
    "expires_at": null,
    "revoked_at": null
  },
  "created": true
}
```

| Field | Type | Description |
| --- | --- | --- |
| `share` | `ShareOverview` | `id`, `token` (used in the public URL), `subject_kind`, `subject_id`, `created_by`, `include_annotations`, `created_at`, `expires_at` (nullable), `revoked_at` (nullable). |
| `created` | boolean | `false` when an identical share already exists and the existing one is returned. |

Errors: `403 Forbidden`, `404 NotFound`, `422 Validation`.

#### GET /v1/shares

Auth: required.

Lists the authenticated user's shares.

No query parameters.

Response: `200` with an array of `ShareOverview`.

Errors: `422 Validation`.

#### DELETE /v1/shares/:share_id

Auth: required.

Revokes a share. Revoked shares return `404` from the public endpoint.

Path parameters: `share_id` (`Uuid`).

Response: `204 No Content`.

Errors: `404 NotFound`, `422 Validation`.

### Public

#### GET /v1/public/shares/:token

Auth: none.

Resolves a share token to the shared content. This endpoint is unauthenticated
so shared links work for anyone. The response carries
`X-Robots-Tag: noindex` and `Referrer-Policy: no-referrer` headers.

Path parameters: `token` (string) - the share token.

Response: `200` with a `SharedShareDetail`, a union discriminated by
`subject_kind`:

**`subject_kind: "session"`**:

| Field | Type | Description |
| --- | --- | --- |
| `subject_kind` | `"session"` | Discriminator. |
| `title` | string | Session title. |
| `markdown` | string | Rendered session markdown. |
| `created_at` | ISO 8601 | Creation time. |

**`subject_kind: "reference"`**:

| Field | Type | Description |
| --- | --- | --- |
| `subject_kind` | `"reference"` | Discriminator. |
| `title` | string or `null` | Reference title. |
| `markdown` | string | Rendered reference markdown. |
| `origin` | string or `null` | Origin annotation. |
| `author` | string or `null` | Author. |
| `published` | string or `null` | Publication date. |
| `annotations` | array | `SharedAnnotation` entries: `anchor` (`{quote, context: string or null, block_offset: number or null}`), `exchanges` (array of `{query, answer}`), `created_at`. |
| `created_at` | ISO 8601 | Creation time. |

Errors: `404 NotFound` (unknown, expired, or revoked share),
`422 Validation`.

## Integration guide

This section walks through a complete integration: authenticate with an API
key, list your vaults, create a reply, and consume its stream. It assumes a
base URL stored in `$BASE` (for example `https://api.example.com`) and the
full API key stored in `$API_KEY`.

### Authenticating

Create an API key once (from the web app or via the code flow), then send it
on every request:

```
Authorization: Bearer <api_key>
```

For one-off interactive use you can also obtain a JWT via the code flow:

```
curl -sS -X POST "$BASE/v1/auth/request-code" \
  -H "Content-Type: application/json" \
  -d '{"email": "you@example.com"}'

curl -sS -X POST "$BASE/v1/auth/verify-code" \
  -H "Content-Type: application/json" \
  -d '{"email": "you@example.com", "code": "123456"}'
```

The response to `verify-code` contains `access_token` (use as the bearer
token) and `refresh_token` (exchange via `POST /v1/auth/refresh` when the
access token expires).

### Listing vaults

```
curl -sS "$BASE/v1/vaults" \
  -H "Authorization: Bearer $API_KEY"
```

Response:

```json
{
  "items": [
    {
      "id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      "name": "Research",
      "owner_id": "0f8fad5b-d9cb-469f-a165-70867728950e",
      "created_at": "2025-06-01T12:34:56.789Z"
    }
  ],
  "pagination": { "limit": 50, "offset": 0, "total": 1 },
  "roles": { "3fa85f64-5717-4562-b3fc-2c963f66afa6": "owner" }
}
```

Take a vault id from `items[].id`; call it `$VAULT`.

### Creating a reply

```
curl -sS -X POST "$BASE/v1/vaults/$VAULT/replies" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "kind": "ephemeral",
    "reply_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    "question": "Summarize the vault",
    "mode": "query",
    "history": []
  }'
```

Response (`202 Accepted`):

```json
{ "reply_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6", "session_id": null }
```

Generate a fresh UUID for `reply_id` on every new question; the server is
idempotent on it.

### Consuming the reply stream

The reply runs in the background. Subscribe to its stream to receive state
updates:

```
curl -N "$BASE/v1/vaults/$VAULT/replies/$REPLY_ID/stream" \
  -H "Authorization: Bearer $API_KEY"
```

Example output (with the keepalive comment visible):

```
event: connected
data: {"id":"3fa85f64-5717-4562-b3fc-2c963f66afa6"}

event: message
data: {"reply_id":"3fa85f64-5717-4562-b3fc-2c963f66afa6","session_id":null,"kind":"ephemeral","status":"running","answer":"","sources":[],"error":null,"version":1,"created_at":"...","updated_at":"..."}

: heartbeat

event: message
data: {"reply_id":"3fa85f64-5717-4562-b3fc-2c963f66afa6",...,"status":"completed","answer":"The vault covers...","sources":[...],"version":3,...}

event: done
data: {"id":"3fa85f64-5717-4562-b3fc-2c963f66afa6"}
```

Python client that handles `connected`/`message`/`done` and ignores comment
lines:

```python
import json
import requests

BASE = "https://api.example.com"
API_KEY = "gm_..."
VAULT_ID = "..."
REPLY_ID = "..."

with requests.get(
    f"{BASE}/v1/vaults/{VAULT_ID}/replies/{REPLY_ID}/stream",
    headers={"Authorization": f"Bearer {API_KEY}"},
    stream=True,
) as response:
    response.raise_for_status()

    event = None
    data_lines = []

    def flush():
        global event, data_lines
        if event is None:
            return
        data = "\n".join(data_lines)
        if event == "connected":
            print("stream connected:", data)
        elif event == "message" and data.strip():
            snapshot = json.loads(data)
            print(f"status={snapshot['status']} version={snapshot['version']}")
            if snapshot["status"] == "completed":
                print("answer:", snapshot["answer"])
        elif event == "done":
            print("stream done:", data)
        event = None
        data_lines = []

    for line in response.iter_lines(decode_unicode=True):
        if line is None:
            continue
        if line.startswith(":"):
            # SSE comment (heartbeat); ignore.
            continue
        if line.startswith("event:"):
            flush()
            event = line[len("event:"):].strip()
        elif line.startswith("data:"):
            data_lines.append(line[len("data:"):].strip())
        elif line == "":
            flush()

    flush()
```

The same pattern applies to `GET /v1/vaults/:vault_id/jobs/:job_id/stream`
with `JobProgressSnapshot` payloads. To follow a job to completion without
streaming, poll `GET /v1/vaults/:vault_id/jobs/:job_id` until
`status` is `completed`, `failed`, or `cancelled`.

### Pagination

Collection endpoints accept `limit` (default `50`, maximum `200`) and
`offset` (default `0`). Page through results by increasing `offset`:

```
GET /v1/vaults?limit=50&offset=0
GET /v1/vaults?limit=50&offset=50
```

Every page envelope contains `pagination.total` (the total number of
matching resources), so you can stop when `offset + items.length >= total`.

### Errors table

| Status | `_tag` | Typical causes |
| --- | --- | --- |
| `400` | `BadRequest` | Malformed request; semantically invalid input (for example, retrying a reply that is not failed, or an upload whose bytes do not match its manifest). |
| `401` | `Unauthorized` | Missing, invalid, or expired bearer token. |
| `403` | `Forbidden` | No access to the resource, insufficient role, or credential kind not accepted (for example, creating a share with an API key). |
| `404` | `NotFound` | Resource does not exist or is not visible to the caller. |
| `409` | `Conflict` | Id already in use by a different request; state conflict. |
| `422` | `Validation` | Request body, query, path, or header failed schema validation. |
| `503` | `ServiceUnavailable` | A required upstream service is unavailable. |

Every error body has the same shape:

```json
{ "_tag": "Validation", "detail": "Invalid query parameters" }
```

## Endpoint index

| Method | Path | Auth | Group |
| --- | --- | --- | --- |
| GET | `/v1/health` | none | meta |
| POST | `/v1/auth/request-code` | none | auth |
| POST | `/v1/auth/verify-code` | none | auth |
| POST | `/v1/auth/refresh` | none | auth |
| POST | `/v1/auth/passkeys/register-options` | required | auth |
| POST | `/v1/auth/passkeys/register` | required | auth |
| POST | `/v1/auth/passkeys/options` | none | auth |
| POST | `/v1/auth/passkeys/verify` | none | auth |
| GET | `/v1/auth/passkeys` | required | auth |
| DELETE | `/v1/auth/passkeys/:id` | required | auth |
| POST | `/v1/auth/api-keys` | required | auth |
| GET | `/v1/auth/api-keys` | required | auth |
| DELETE | `/v1/auth/api-keys/:key_id` | required | auth |
| DELETE | `/v1/auth/me` | required | auth |
| POST | `/v1/me/refs` | required | refs |
| GET | `/v1/me/refs` | required | refs |
| GET | `/v1/me/refs/doc` | required | refs |
| DELETE | `/v1/me/refs/:reference_id` | required | refs |
| PATCH | `/v1/me/refs/:reference_id` | required | refs |
| GET | `/v1/vaults` | required | vaults |
| POST | `/v1/vaults` | required | vaults |
| POST | `/v1/vaults/draft-hint` | required | vaults |
| GET | `/v1/vaults/:vault_id` | required | vaults |
| GET | `/v1/vaults/:vault_id/config` | required | vaults |
| PATCH | `/v1/vaults/:vault_id/config` | required | vaults |
| GET | `/v1/vaults/:vault_id/members` | required | vaults |
| POST | `/v1/vaults/:vault_id/members` | required | vaults |
| PUT | `/v1/vaults/:vault_id/members/:member_user_id` | required | vaults |
| DELETE | `/v1/vaults/:vault_id/members/:member_user_id` | required | vaults |
| POST | `/v1/vaults/:vault_id/transfer-ownership` | required | vaults |
| DELETE | `/v1/vaults/:vault_id` | required | vaults |
| GET | `/v1/vaults/:vault_id/wiki` | required | wiki |
| GET | `/v1/vaults/:vault_id/wiki/recent` | required | wiki |
| GET | `/v1/vaults/:vault_id/raw/sources` | required | sources |
| GET | `/v1/vaults/:vault_id/raw/sources/:source_id` | required | sources |
| DELETE | `/v1/vaults/:vault_id/raw/sources/:source_id` | required | sources |
| POST | `/v1/vaults/:vault_id/raw/sources/:source_id/deletion-request` | required | sources |
| GET | `/v1/vaults/:vault_id/proposals` | required | proposals |
| POST | `/v1/vaults/:vault_id/proposals` | required | proposals |
| GET | `/v1/vaults/:vault_id/proposals/:proposal_id` | required | proposals |
| PATCH | `/v1/vaults/:vault_id/proposals/:proposal_id` | required | proposals |
| POST | `/v1/vaults/:vault_id/ingest` | required | ingest |
| POST | `/v1/vaults/:vault_id/ingest/reference` | required | ingest |
| POST | `/v1/vaults/:vault_id/ingest/user-suggestion` | required | ingest |
| POST | `/v1/vaults/:vault_id/file-ingests/check-dupes` | required | ingest |
| POST | `/v1/vaults/:vault_id/file-ingests` | required | ingest |
| GET | `/v1/file-ingests/:batch_id` | required | ingest |
| POST | `/v1/file-ingests/:batch_id/resume` | required | ingest |
| POST | `/v1/file-ingests/:batch_id/files/:hash/complete` | required | ingest |
| POST | `/v1/file-ingests/:batch_id/commit` | required | ingest |
| POST | `/v1/file-ingests/:batch_id/files/:hash` | required | ingest (raw route) |
| POST | `/v1/vaults/:vault_id/jobs/url` | required | jobs |
| POST | `/v1/vaults/:vault_id/jobs/:job_id/retry` | required | jobs |
| GET | `/v1/vaults/:vault_id/jobs` | required | jobs |
| GET | `/v1/vaults/:vault_id/jobs/:job_id` | required | jobs |
| GET | `/v1/vaults/:vault_id/jobs/:job_id/stream` | required | jobs |
| POST | `/v1/vaults/:vault_id/compile` | required (owner) | compile |
| POST | `/v1/vaults/:vault_id/compile/:run_id/cancel` | required (owner) | compile |
| GET | `/v1/vaults/:vault_id/lint` | required | lint |
| GET | `/v1/costs` | required | costs |
| GET | `/v1/vaults/:vault_id/costs` | required | costs |
| GET | `/v1/vaults/:vault_id/doc` | required | documents |
| GET | `/v1/vaults/:vault_id/chunks` | required | documents |
| GET | `/v1/vaults/:vault_id/links` | required | documents |
| POST | `/v1/vaults/:vault_id/sessions/:session_id/exchanges/:exchange_id/promote` | required | sessions |
| GET | `/v1/vaults/:vault_id/sessions` | required | sessions |
| GET | `/v1/vaults/:vault_id/sessions/by-origin` | required | sessions |
| GET | `/v1/vaults/:vault_id/sessions/:session_id` | required | sessions |
| GET | `/v1/vaults/:vault_id/sessions/:session_id/markdown` | required | sessions |
| POST | `/v1/vaults/:vault_id/replies` | required | replies |
| POST | `/v1/vaults/:vault_id/replies/:reply_id/retry` | required | replies |
| GET | `/v1/vaults/:vault_id/replies/:reply_id/stream` | required | replies |
| POST | `/v1/shares` | required | shares |
| GET | `/v1/shares` | required | shares |
| DELETE | `/v1/shares/:share_id` | required | shares |
| GET | `/v1/public/shares/:token` | none | public |

Unversioned routes outside the table above: `GET /` and `GET /health` both
return `200` with `{"status": "ok"}`.
