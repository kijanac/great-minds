# Offline conversation conversion

This is one-off tooling for **stopped, isolated local copies**, not a production deployment command. It converts the detached legacy conversation format into native JSONL and coordinated database projections. Normal application code does not read both formats or dual-write them.

The implementation is split by boundary:

- `packages/server/scripts/lib/conversation-history-conversion.ts`: pure decoding, conversion, dependency inspection, database patch planning and exception reporting.
- `packages/server/scripts/lib/conversation-history-cutover.ts`: guarded PostgreSQL inventory, expected-old verification, migration ordering and projection installation.
- `packages/server/scripts/migrate-conversation-history.ts`: local-copy capture, dry-run staging and conditional installation.
- `packages/server/scripts/rehearse-conversation-conversion.ts`: temporary synthetic migration/recovery proof, deliberately outside the permanent Vitest suite.

See the [migration contract](future-ideas/conversation-history-contract-and-migration.md) and [native workflow guide](conversation-workflow-integration.md). These tools do not waive their production release gates.

## Scope and authority

The input is the supported legacy `meta`/`reply` JSONL format and legacy session/reply database rows. Other shapes fail rather than acquiring a permanent compatibility path. The snapshot contains every session and reply, the complete local object-key/hash inventory, a PostgreSQL dump hash, and content hashes for the other public database tables. Checkpoints, source files, derived Markdown, configuration and unrelated objects are preserved, not rewritten into conversation history.

A table control hash is SHA-256 over the sorted, newline-delimited SHA-256 digests of its PostgreSQL `to_jsonb(row)::text` values, with the session time zone fixed to UTC. Rows are streamed rather than concatenating an entire table into one PostgreSQL string. These hashes detect changes to permissions, shares, source/proposal identities and other application data while the converter updates only conversation rows.

**The dump and object copy must come from the same quiescent backup window.** Hashing an arbitrary dump does not prove that it matches a database. Restore that dump into the isolated database before inventorying it, and prove restoration before any real cutover. Capturing twice around file reads detects observed changes; it is not a substitute for fencing writers or an atomic snapshot of a live application.

The whole application needs its database, object content and checkpoints together. Retain the compatible application/configuration and necessary runtime secrets separately in the protected restore procedure; this inventory is not an environment or secret-manager backup. This is not a claim that JSONL can reconstruct every unfinished execution after loss of the other stores.

## What is preserved, unknown or blocked

Conversion preserves session, exchange and reply IDs; literal questions, answers and resolved sources; retained messages and tool results; accepted-attempt order; original parent pointers; and inherited context cutoffs. Exact duplicate records are reported and deduplicated. Different payloads for the same identity block conversion.

- A pending record plus a completed/stopped record becomes an attempt and settlement.
- A terminal-only record can become an attempt with unknown acceptance time. Its time is not inferred from its completion timestamp. When a corresponding database request cannot be wrapped into an exact native admission descriptor without inventing that time, installation is blocked for review.
- A pending record with a committed failed database row preserves the committed partial answer and resolved sources as a failure. Unresolved pending sources are reported and excluded from the settled source list. Missing retained messages or settlement time stay unknown. Raw provider diagnostics are not copied into the native public-facing error message.
- Recorded terminal history can repair a stale running database projection. The tool does not regenerate the answer or invoke a model/tool.
- Unresolved running work, ambiguous retry ordering, conflicting terminal outcomes, missing records, dangling or cross-owner dependencies and dependency cycles block installation.
- Legacy answer origins name an exchange, not an anchored attempt. The converter requires a unique eligible recorded attempt rather than guessing from the currently selected attempt. The annotation anchor and inherited model-context cutoff remain separate.
- Current session kind and legacy request intent do **not** establish historical generation mode. Preparation metadata is retained only when checkpoint ownership, vault, cursor, current-turn messages, answer/sources and the actual system-prompt digest agree. Otherwise generation provenance remains unknown and is reported. Absence of provenance is not evidence that no external call occurred.
- Saved request options are parsed strictly and wrapped in the native accepted-request shape. Their recorded intent is not relabelled as verified generation provenance. Exact create replay checks the accepted ID and payload even for a historical later attempt whose question differs from its predecessor. Explicit retry additionally checks its supplied predecessor; a fresh create ID still cannot reuse an existing exchange.

A plan may contain partial outputs for inspection, but **any report error prevents installation**. Resolve exceptions with evidence and a new reviewed inventory; do not edit the report to suppress them. There is no force/guess/replay option.

## Capture and stage an isolated copy

Use a private directory outside the repository. Inventories, dumps, staged JSONL and database patches contain sensitive plaintext. The tool creates private directories and files and refuses existing output directories. Keep the snapshot immutable; do not use it as the working application directory.

The database URL must explicitly name the database, use `postgres:`/`postgresql:` and `127.0.0.1`, and contain no query or fragment overrides (including a PostgreSQL `host` query override). The database must also carry one of these server-side settings:

```sql
ALTER DATABASE gm_conversation_copy
SET great_minds.migration_purpose = 'conversation-history-copy';
```

The purpose-marked database created by `pnpm test:history-settlement` is also accepted. A URL spelling alone is insufficient. These guards prevent accidental use of an ordinary application database; they do not authorize production access or prove that old writers have been stopped.

After restoring the matching dump and object backup into isolated copies:

```sh
node --experimental-strip-types packages/server/scripts/migrate-conversation-history.ts capture \
  --database-url-env COPY_DATABASE_URL \
  --objects "$COPY_OBJECTS" \
  --backup "$RESTORED_DATABASE_DUMP" \
  --output "$SNAPSHOT" \
  --writers-stopped

node --experimental-strip-types packages/server/scripts/migrate-conversation-history.ts plan \
  --snapshot "$SNAPSHOT" \
  --output "$STAGE"
```

Export `COPY_DATABASE_URL` with isolated-copy credentials beforehand. The option names the environment variable explicitly so its credential-bearing value is not placed in command-line arguments. There is no fallback to ambient `DATABASE_URL`.

Capture writes `database.dump`, `objects/` and `snapshot.json`. Planning writes:

- `report.json`: source identity, converted/preserved counts, object hashes, attempt identities/outcomes, per-attempt equality checks for questions/answers/sources/retained messages, and exception codes. It distinguishes unknown retained messages from recorded empty arrays. An equality failure blocks installation. It does not copy prompts, answer text or provider errors into the report.
- `database-patch.json`: complete before/after conversation rows. **This file is sensitive**, including original requests and diagnostic fields in the before-state.
- `objects/`: staged native history replacements only.

A blocking dry run exits nonzero. Other object bytes remain accounted for by the snapshot inventory and are not replacement outputs. Missing, extra, changed, symbolic-link or unsupported object files are refused where the copy is loaded or installed. The scoped `.conversation-history.lock` is ownership state, not backup content.

## Install only into a stopped isolated copy

The snapshot, stage and target directories must be separate, including their resolved filesystem locations. Copy the snapshot's object tree to the target and use the restored database with writers still stopped:

```sh
node --experimental-strip-types packages/server/scripts/migrate-conversation-history.ts apply \
  --database-url-env COPY_DATABASE_URL \
  --snapshot "$SNAPSHOT" \
  --stage "$STAGE" \
  --objects "$TARGET_OBJECTS" \
  --writers-stopped
```

Apply reconstructs the plan from the verified snapshot and compares the staged report, database patch and history bytes. It checks complete database row identities and values, the unrelated-table controls, and the entire target object inventory before replacing histories. A destination must match its expected legacy hash or exact native output hash; an unrelated value is never overwritten.

Installation uses the native scoped local writer and conditional whole-object replacement. A verified already-installed object is a no-op. All history targets are checked before the first replacement. A conflict or interruption can leave a partially converted **stopped copy**, not an application safe to reopen.

After object installation, stale legacy reply projections are repaired before applying the native schema migrations. This matters when several obsolete `running` rows would otherwise prevent creation of the one-live-operation index. The final database transaction takes non-waiting session/reply table locks, verifies expected rows again, installs native requests/terminal projections and the single session sequence/hash receipt, and verifies the resulting state. Object I/O does not occur under database locks.

Reapplying the same reviewed plan accepts only exact supported before/applied states. It does not manufacture recovery by overwriting unknown intermediate values. Keep writers stopped after any failure: inspect the exception, safely resume verified states, or restore the whole isolated backup. Do not manually delete a live ownership lock.

The tool provides neither live R2 capture/install nor a production cutover switch. Backend version inventory, production writer fencing and deployment coordination still require their own authorized operational procedure.

## Recovery and rehearsal

Run the one-off synthetic proof only through the owned-database runner:

```sh
pnpm test:history-settlement --script packages/server/scripts/rehearse-conversation-conversion.ts
```

The runner creates and removes its own UUID-labelled PostgreSQL project. The script additionally requires an empty, purpose-marked database before rebuilding the legacy fixture schema. It does not read a production backup. Its private temporary artifact directory is reported on completion or failure.

The proof exercises deterministic conversion and exception cases, source/stage/destination changes, an interrupted conditional installation, repeated application, an actual PostgreSQL dump/restore with all object bytes, and native conversation services. Model/provider HTTP calls are forbidden rather than used to generate replacement answers. A successful service-level rehearsal is not a browser interaction, live-provider or R2 deployment test.

### Verified fixture checkpoint

The settled-source rehearsal passed in job `12354a42-1424-4386-ad8d-5e00e8e71f4e` (29 seconds including static checks and owned database setup/cleanup). Its private artifacts are at `/tmp/gm-conversion-proof-OzR1Jt/`; `proof.json` records the completed checks and invocation counters. The real CLI exercised `capture`, `plan` and `apply`.

The fixture contains **four conversations, six database reply rows, seven accepted attempts/settlements and seven objects**. Four history objects were converted; two checkpoint files and one source file were preserved byte-for-byte. It includes failed committed partials, stale running projections, retries with different historical questions, repeated quotes at different offsets, a continued BTW whose verified historical mode remains BTW, and a terminal-only import with unknown acceptance time. Every converted attempt passed the question/answer/source/message equality checks.

Verified failures include conflicting/unsupported records, ambiguous attempts/anchors, dangling/cyclic/cross-owner dependencies, unresolved operations, changed source/stage/target data, and changed ownership metadata. Unsupported checkpoint provenance stays unknown. The report-content checks reject accidental inclusion of fixture questions, answers, system text or provider diagnostics.

The install was interrupted after its first acknowledged conditional object write, then completed through a fresh CLI invocation and safely reapplied. An actual PostgreSQL dump/restore plus restoration of every inventoried object reproduced the original state before reopening native writes. The application-service pass verified private reads, owner denial, the existing bearer share, terminal reply streaming, retained follow-up tool context, exact submission replay, Continue, explicit retry and deterministic promotion. New follow-up/retry answers were synthetic values admitted and settled through the real coordinators, not provider-generated answers. **Model calls: zero. Provider/tool HTTP calls: zero.** A later apply refused the genuinely changed native state.

This is not a live-provider, browser/HTTP-route, R2, all-workflow-resumption, arbitrary-scale, power-loss or production-backup proof. It does not establish safe restoration of an old backup after new native writes. The fixed example data and minimal terminal checkpoint fixtures cannot substitute for a reviewed real inventory.

The rehearsal also exposed an exact-replay bug in admission. Two existing regression cases first failed; the fix checks the predecessor only when the retry endpoint supplies one. All **53 admission tests** then passed, including rejection of a mismatched retry predecessor and rejection of a fresh create ID for an existing exchange. The **52 parser/history tests** and the focused real-EOF workflow regression also passed: **106 distinct targeted cases across four files**, not 106 new tests. The earlier full 55-case query/parser run overlaps these checks. Whole-workspace typechecking, scoped lint/format and documentation checks passed. No new schema migration, dispatch-state change or reconnect-policy change was introduced.

### Evidence retention and remaining release gates

The executable is migration proof material, not justification for a permanent cross-product regression matrix. Keep its reviewed evidence with the migration checkpoint, and archive/remove the one-off converter and proof after the migration window closes. Stable runtime history, durability, admission, settlement and parser contracts retain their existing regression coverage.

Before native writes are reopened, rollback restores **both** the compatible application/database and all required object content/checkpoints. After new native writes, restoring the old backup would discard those writes: re-quiesce and plan a forward repair or separately reviewed reverse conversion. Reapplying the old plan must not overwrite the new state.

Production remains gated on an authorized real backup inventory, reviewed/resolved exceptions, matching-store restore proof, backend-specific expected-old checks, stopped/fenced legacy writers, coordinated database/API/web/worker deployment, and operator approval. None is implied by a synthetic rehearsal.
