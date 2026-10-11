# Compile ownership and local-first compile semantics

> **Status:** exploratory proposal, not a verified decision. This note records current observations and possible future designs.

## Current relationship between vault ownership and compiles

Today, compile execution is primarily **vault-scoped**, not user-scoped.

The compile workflow payload is:

```ts
{
  intentId,
  vaultId,
  pipelineRunId
}
```

The compile workflow idempotency key is the compile intent ID.

### Owner-gated actions

Manual compile request currently requires vault owner:

- `JobsService.requestCompile(...)` calls `access.requireOwner(userId, vaultId)`.

Compile cancellation also requires owner:

- `JobsService.cancelCompile(...)` calls `access.requireOwner(userId, vaultId)`.

### Member-visible actions

Job listing, job get, and progress stream require membership, not ownership.

### Editor/content paths

Editors can affect future compile inputs indirectly through proposals/suggestions depending on workflow. Owner approval writes content and can enqueue compile intents.

Current examples:

- Owner raw ingest/promotion writes source and enqueues compile.
- Editor user suggestion may create a proposal rather than directly ingest.
- Proposal approval by owner can write source content and enqueue compile.
- Source deletion currently deliberately creates no compile intent.

### Important interpretation

Ownership gates who can trigger/cancel manual compile through the API. But the compile output semantically belongs to the **vault state**, not to the owner personally.

Ownership transfer alone should not invalidate a compile. Content/config changes should.

## Gap: requested-by attribution

Current compile records do not appear to preserve who requested the compile.

For privacy/local-first/collaboration, consider eventually adding:

```ts
requested_by_user_id
requested_by_device_id
requested_by_role
request_reason // manual, ingest, proposal_approval, scheduled, sync_pull, etc.
```

Benefits:

- auditability;
- cost attribution;
- explaining background work;
- validating signed local-first commits;
- debugging duplicate/expensive compiles.

This should not change the semantic owner: compiles remain vault projections.

## Proposed compile model: snapshot-based projection

A compile should be treated as a projection from a specific vault snapshot:

```ts
compile_intent {
  id
  vault_id
  requested_by_user_id?
  requested_by_device_id?
  request_reason
  base_vault_head
  source_manifest_hash
  config_hash
  created_at
}

compile_run {
  id
  intent_id
  phase
  checkpoint
  active_invocation?
  status
}

compile_publication {
  run_id
  vault_id
  base_vault_head
  output_manifest_hash
  article_manifest_hash
  topic_graph_hash
  published_at
}
```

The key is `base_vault_head`: the exact canonical vault commit/source/config state being compiled.

## Publish semantics

Before publishing compile output, check whether the current vault head still matches the compile's `base_vault_head`.

Possible policies:

### Strict publish

If head changed, do not publish. Mark run stale and enqueue a new compile.

Pros:

- avoids publishing old compile over newer content;
- easy to reason about.

Cons:

- frequent edits can starve compile publication.

### Publish stale but not canonical

Store artifact as historical/stale, but do not make it current.

Pros:

- preserves work for debugging/cost review;
- can be useful for comparison.

Cons:

- UI complexity.

### Merge-aware publish

If changes do not affect compiled source/config, publish anyway.

Pros:

- avoids unnecessary recompiles.

Cons:

- requires accurate dependency tracking.

A simple v1 should probably use strict publish or stale-not-canonical.

## Compile artifacts in local-first vaults

In a shared encrypted vault, a compile artifact should be a signed commit or signed artifact attached to a commit.

Sketch:

```json
{
  "type": "compile_snapshot",
  "vault_id": "...",
  "base_commit": "...",
  "source_manifest_hash": "...",
  "config_hash": "...",
  "compiler_user_id": "...",
  "compiler_device_id": "...",
  "membership_epoch": 7,
  "topic_graph_object": "encrypted-object-hash",
  "article_objects": ["..."],
  "created_at": "...",
  "signature": "..."
}
```

Other devices can verify:

1. the artifact was compiled from the vault state they know;
2. the compiler device was authorized at that membership epoch;
3. the artifact objects exist and decrypt;
4. the signature is valid.

## Compile authority in shared vaults

There are three separate questions:

### Who can run a local compile?

Anyone with decrypted vault content can run a local compile. This cannot be prevented cryptographically after access has been granted.

### Who can publish a canonical compile?

This should be governed by role policy.

Possible policy:

- owner: can publish canonical compile;
- editor: can publish if vault allows editor-published compiles;
- viewer: can run local private compile but cannot publish canonical shared compile.

### Who accepts a compile as canonical?

Each device should validate signature, role, membership epoch, and base commit before accepting a remote compile as current.

## Revocation and compile

Revoking a user cannot erase compile outputs or source content they already decrypted.

Revocation can prevent:

- publishing new canonical compiles in the current epoch;
- decrypting new compile artifacts after key rotation;
- fetching current remote heads/keys through the coordination service.

Compile artifacts from old epochs may remain accessible until re-encrypted/compacted and old packs are garbage-collected.

## Relationship to graph and query UX

### If compile snapshots are canonical

- Devices can sync accepted topic/article graph.
- Query can immediately use the shared current wiki state.
- Local search/vector indexes are rebuilt from synced canonical artifacts.
- Compile quality and graph identity are shared across collaborators.

### If compile snapshots are local-only

- Every device may see different wiki/topic graph depending on local model/cache.
- Sharing citations and article links becomes harder.
- Query answers may diverge between collaborators.

For collaborative vaults, canonical compile snapshots are likely preferable.

## What invalidates a compile?

Likely invalidators:

- source added/removed/changed;
- source metadata changed;
- vault config changed (`kinds`, `thematic_hint`, metadata schema);
- compile prompt/model version changed if output should be regenerated;
- accepted proposal affecting source corpus;
- membership/key changes only if policy requires re-signing/re-encrypting artifacts, not because semantic content changed.

Likely non-invalidators:

- ownership transfer alone;
- role change alone, unless it changes artifact acceptance policy;
- local search index rebuild;
- reply/session changes not promoted to sources.

## Potential schema additions

Exploratory additions:

```ts
compile_intents.requested_by_user_id
compile_intents.request_reason
compile_intents.base_vault_head
compile_intents.source_manifest_hash
compile_intents.config_hash

pipeline_runs.requested_by_user_id
pipeline_runs.requested_by_device_id

compile_publications.run_id
compile_publications.base_vault_head
compile_publications.output_manifest_hash
compile_publications.published_by_device_id
compile_publications.signature
```

For the current centralized app, some of these may be overkill. For local-first shared vaults, they become more important.

## Open questions

- Should editors be able to request manual compiles, or only owners?
- Should editor-approved proposals auto-compile if owner approval is the publication boundary?
- Should compiles be automatic after any source mutation, manually triggered, or both?
- Should failed/stale compile artifacts be retained for audit/cost/debugging?
- What is the product meaning of a compile produced by a revoked-but-previously-authorized device?
- How should UI show “compiled from older vault state”?
