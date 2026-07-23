-- ============================================================================
-- Diagnose + fix a stuck pipeline run.
-- Run from Render shell:
--   Render dashboard → great-minds-api → Shell tab
--   then:  psql $DATABASE_URL -f diagnose.sql
-- ============================================================================

-- 1. Pipeline run state
SELECT '--- PIPELINE RUN ---' AS section;
SELECT id, vault_id, status, current_phase, phase_status,
       error, updated_at, completed_at,
       compile_task_id, active_task_id, active_task_type
FROM pipeline_runs
WHERE id = 'd676ed40-74db-4410-9cfc-d4171845a59f';

-- 2. Durable workflow messages for this pipeline
SELECT '--- WORKFLOW MESSAGES ---' AS section;
SELECT id, message_id, entity_type, entity_id, tag, processed, payload
FROM cluster_messages
WHERE payload::jsonb->>'pipelineRunId' = 'd676ed40-74db-4410-9cfc-d4171845a59f'
ORDER BY id DESC;

-- 3. Advisory locks held on the vault
--    (vault_id comes from query #1 — fill in below after running)
SELECT '--- ADVISORY LOCKS ---' AS section;
SELECT pid, locktype, classid, objid, objsubid, mode, granted,
       pg_blocking_pids(pid) AS blocked_by
FROM pg_locks
WHERE locktype = 'advisory'
ORDER BY pid, objid;

-- ============================================================================
-- FIX (run interactively after reviewing the diagnostic output above):
-- ============================================================================

-- Step A: Release advisory lock on the vault.
--         Replace <VAULT_ID> with the vault_id from query #1.
-- SELECT pg_advisory_unlock(hashtextextended('<VAULT_ID>', 0));

-- Step B: If the lock is held by another backend, kill it.
--         Replace <PID> with the pid from query #3.
-- SELECT pg_terminate_backend(<PID>);

-- Step C: Mark pipeline run as failed.
-- UPDATE pipeline_runs
-- SET status = 'failed',
--     error = 'Manually failed — stuck on compile advisory lock',
--     completed_at = now(),
--     updated_at = now()
-- WHERE id = 'd676ed40-74db-4410-9cfc-d4171845a59f';
