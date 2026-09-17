# BTW conversations

A session is a standalone conversation. A BTW is a persistent, linear aside anchored to a document passage or a completed session answer. Both own their reply history. `sessions.kind` controls presentation; the origin records where the thought began. A BTW cannot be the origin of another BTW.

An answer BTW inherits the latest completed main conversation when its first question is accepted. Selecting A1 after U2/A2 have completed includes U2/A2 in that inherited context. The selected A1 passage remains the focus. Metadata records the inherited session and reply IDs independently of the selected answer. Subsequent main replies and sibling BTWs are excluded. Later BTW turns follow only their own history plus that fixed ancestry. Immediate-parent tool results are retained; older tool outputs use the existing omission marker.

Continue as a session changes the conversation kind in place. Its ID, history, original passage, and inherited context remain intact. The session list then includes it, and its origin renders a link to the session. Direct links to an unpromoted BTW return to its origin. The API checks ownership and treats repeated promotion requests as successful.

## Migration

The SQL migration `20260917175636_btw_conversations` adds the explicit kind, classifies existing anchored conversations as BTWs, and tags existing document origins. The accompanying `packages/server/scripts/migrate-session-replies.ts` converts historical JSONL and saved reply requests together, splitting embedded answer BTWs into their own conversations with deterministic IDs. Original passage data is preserved. For legacy BTW snapshots, the first observed snapshot time determines inherited context; subsequent snapshots do not advance it. Existing reply nodes retain their explicit parent relationship.

This is a coordinated data and application rollout. New code cannot read legacy exchange/BTW event files directly. Keep API and background writers stopped while applying the schema and file conversion; restart only with compatible API and browser versions.

1. Resolve historical sessionless reply retention before applying the earlier `20260908155003_session_reply_requests` migration. That migration deliberately refuses those rows. The 28 previously inventoried production replies still require a retention decision; this change does not delete or manufacture sessions for them.
2. Back up the database and content store before applying any migration. Rehearse the complete sequence on a copy with the same storage configuration.
3. Apply pending database migrations. With database and storage environment variables configured, run `node --experimental-strip-types packages/server/scripts/migrate-session-replies.ts` for a read-only preview.
4. Resolve reported missing histories, unmatched replies, or historical nesting. Run the same command with `--apply` only after reviewing the preview. Apply refuses running replies and completes all preflight checks before writing.
5. Verify the original questions, answers, selected passages, request destinations, and conversation counts before restarting the application.

The converter first saves each original JSONL, existing Markdown sidecar, and related database rows under `migrations/btw-conversations/<session-id>/` in that vault's content store. It writes converted files, then updates the database in one transaction. Files and SQL are not a distributed transaction: keep writers stopped and retry a failed conversion against its preserved originals. A retry refuses histories that have changed since backup. Independent database and content backups remain the rollback source.

Production has not been migrated as part of this implementation.
