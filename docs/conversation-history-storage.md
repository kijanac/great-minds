# Conversation history storage

## Scope

This is the Stage 2B.1 storage foundation for the [conversation-history contract](future-ideas/conversation-history-contract-and-migration.md). It is not yet wired into live session/reply services and does not switch existing files to the new format.

JSONL owns recorded session content, including saved tool activity and the model-facing messages needed by ordinary follow-ups. The database still owns permissions, application choices, and operation coordination; checkpoints retain unfinished execution state. Whole-application recovery requires these stores together. Markdown is derived presentation, not another editable content authority.

The history path remains:

```text
vaults/<vault_id>/sessions/<session_id>.jsonl
```

## Module boundaries

- `packages/server/src/conversation-history/schema.ts` defines the versioned header, accepted attempt, and settlement records.
- `packages/server/src/conversation-history/history.ts` parses external bytes, checks record relationships, reduces accepted attempts, plans idempotent additions, and verifies byte-prefix receipts. Typed writes are not decoded again as unknown input.
- `packages/server/src/conversation-history/store.ts` coordinates a complete read, semantic append planning, and conditional replacement. It does not authorize callers, invoke models/tools, update the database, or schedule retries.
- `packages/server/src/storage/object-store.ts` defines the narrow `ConditionalObjectStore` capability, separately from existing general object operations.
- `packages/server/src/storage/r2-object-store.ts` implements that capability using R2 conditional requests.
- `packages/server/src/storage/local-conditional-object-store.ts` implements it under scoped local writer ownership.

The existing `ObjectStore.append` and live session writer are unchanged. They must not remain competing writers to migrated histories at cutover.

## Commit behavior

A commit reads the current whole object, parses it, and compares proposed records by natural identity and content. Equal records are already committed; they consume no sequence number and trigger no object write. Different content for an existing identity is a conflict, not a replacement. New records receive contiguous sequence numbers. The first header and first attempt must be committed together.

Existing history text is preserved rather than re-encoded. A new batch replaces the whole object only if the backend version still matches the read, or the object is still missing for first creation.

| Result | Meaning | Responsibility of the future operation coordinator |
| --- | --- | --- |
| Success, `written: true` | The backend acknowledged the conditional write | Record the history receipt and finish DB bookkeeping |
| Success, `written: false` | The exact records are already present | Finish DB bookkeeping without writing duplicate records |
| `ObjectVersionConflict` | The conditional write did not establish success against that version | Retain the same batch and reconcile against a fresh read; do not overwrite |
| `StorageBackendError` | Reading or writing could not be confirmed | Retain the obligation; a failed write response does not prove the write was absent |
| `HistoryConflict` | An identity already has different recorded content | Surface an integrity conflict; do not select a timestamp winner |
| `HistoryInvalid` | Stored bytes, record relationships, or a known receipt are inconsistent | Preserve the file and diagnose it; do not silently repair or append over it |

The history coordinator does not retry inline. Durable admission/finalization will own redelivery under the same IDs and recheck operation eligibility. Storage trouble must not trigger another model or tool invocation.

A history revision is a sequence count plus SHA-256 of exact JSONL bytes. A backend version is an opaque conditional-write token. These serve different purposes. A known receipt can detect a missing object or missing complete tail that would otherwise parse as an older valid history. Parsing alone cannot prove that no complete tail was lost.

## R2

Creation uses `If-None-Match: *`; replacement uses the exact ETag in `If-Match`, including its quotes. Missing or empty ETags are storage errors for versioned reads. HTTP precondition failures become `ObjectVersionConflict`; other request failures remain storage errors.

The existing SDK transport behavior remains in place. The history path does not add the byte-append retry policy. If a response is lost after a successful PUT, a later commit reads the saved records and resolves an equal delivery as a no-op. It does not blindly append again.

The conformance fixtures exercise the real S3 SDK against a fake HTTP request handler. They test request encoding and error mapping, not a live R2 service or its physical durability.

## Local ownership

Open one scoped adapter for an existing, private local storage root. It resolves the real path and acquires an exclusive OS advisory lock on the stable file:

```text
<root>/.conversation-history.lock
```

The lock file is never unlinked on release. Deleting a live lock file would let another process lock a different inode at the same path and defeat exclusion. Its age and contents are not ownership evidence.

`fs-native-extensions@1.5.1` supplies the OS operation absent from Node's built-in filesystem API. On Linux it uses open-file-description locks (`F_OFD_SETLK`). A second descriptor cannot acquire the exclusive lock, including in the same process. Closing the owning descriptor, or process death, releases the lock. There is no PID inference, lease timeout, stale-lock takeover, or operator cleanup required after a crash.

The native package loads when the local adapter opens, so an R2-only process does not need to load its native binary. `fs-native-extensions.d.ts` supplies the package's missing TypeScript signature; it is not a runtime wrapper. A failed native load or unsupported lock operation fails initialization rather than falling back to unsafe writes.

Within the owner, a semaphore serializes filesystem operations. Scope closure waits for in-flight I/O before releasing the descriptor. Started filesystem operations are uninterruptible so cancellation cannot release ownership while an asynchronous rename is still pending. Closed adapter handles reject further reads and writes.

This is a cooperative ownership protocol, not a security boundary against other programs running as the filesystem owner. Every writer to these histories must use it. Legacy writers, external editors, and deleting or replacing the lock file can bypass it. Integration must stop/fence old writers rather than claim that this advisory lock already protects current `ContentStorage` calls.

The tested target is a Linux local filesystem. Shared/network filesystems and other platforms are not established by these tests. The root must support exclusive locking, file/directory flushes, and atomic same-directory rename; failures are not ignored.

## Local replacement and recovery

A write creates/checks parent directories and flushes their parents, compares the current content token while holding the semaphore, and writes a uniquely named sibling temporary file. It flushes and closes that file, renames it over the destination, and flushes the containing directory before success.

A versioned read flushes the file and containing directory before returning. This matters when a previous rename succeeded but its final directory flush failed: simply finding readable new bytes is not enough to confirm the operation. An equal replay can succeed only after that read/flush succeeds.

| Interruption point | Destination visible after process death |
| --- | --- |
| Before first rename | Absent; an uncommitted temporary file may remain |
| Before replacement rename | Previous complete history |
| After rename | New complete history, which redelivery confirms through the normal read path |

Pre-rename temporary files are not committed history and are never recovered as if they were. They may remain after process death; this slice does not introduce automatic garbage collection. Ordinary write failures attempt to remove their temporary file, and cleanup errors are not silently swallowed.

The tests kill actual child processes immediately before and after rename, check that a live owner excludes another process, reopen after death without lock cleanup, and redeliver the same history batch. They also inject file-flush, directory-flush, and rename failures and exercise cancellation during replacement.

These are process-crash and API-protocol guarantees, not proof of host-power-loss durability, storage-controller behavior, or a transaction spanning JSONL and PostgreSQL.

## Executable coverage and remaining integration

Focused suites:

- `packages/server/test/conversation-history.test.ts`: format, reduction, record identity, append planning, receipts, and external history dependencies.
- `packages/server/test/conditional-object-store.test.ts`: local/R2 conditional creation and replacement, contention, detached bytes, and R2 request/error semantics.
- `packages/server/test/conversation-history-store.test.ts`: competing semantic commits, equal replay, lost acknowledgments, conflicting settlements, failed writes, malformed-history preservation, and receipt checks.
- `packages/server/test/local-conditional-object-store.test.ts`: ownership, lifecycle, cancellation, path boundaries, and filesystem failure windows.
- `packages/server/test/history-process-crash.test.ts`: actual writer process death before/after first creation and replacement.

These tests use temporary local directories and an in-memory fake R2 bucket, not a database or production storage. Existing session, migration, Markdown, and storage tests remain regression checks; they are not proof that the new protocol is active in the application.

Next is application integration: durable acceptance/admission, acceptance-time mode capture, a frozen terminal payload with `settling`, one completed/stopped/failed finalizer, reconciliation, and progress fencing. Authorized readers, consumer cutover, and verified offline migration follow. None of the storage work alone establishes those release gates.
