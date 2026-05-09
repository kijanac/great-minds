"""Diagnose and fix a stuck pipeline run.

Quick diagnostic queries that surface the exact state of a pipeline run,
its associated Absurd compile task, and any lingering advisory locks.

Usage:
  uv run scripts/diagnose_stuck_pipeline.py <pipeline_run_id>          # diagnose only
  uv run scripts/diagnose_stuck_pipeline.py <pipeline_run_id> --fix    # diagnose + fix
"""

import argparse
import asyncio
import os
import sys
from uuid import UUID

import asyncpg
from dotenv import load_dotenv


def _parse_args():
    parser = argparse.ArgumentParser(description="Diagnose/fix stuck pipeline runs")
    parser.add_argument("pipeline_run_id", type=str, help="Pipeline run UUID")
    parser.add_argument(
        "--fix",
        action="store_true",
        help="Release advisory lock + fail the pipeline run",
    )
    parser.add_argument(
        "--db-url",
        type=str,
        default=None,
        help="Database URL (defaults to DATABASE_URL from .env)",
    )
    return parser.parse_args()


def _db_url(explicit: str | None) -> str:
    if explicit:
        url = explicit
    else:
        load_dotenv()
        url = os.getenv("DATABASE_URL")
        if not url:
            sys.exit("DATABASE_URL not set in environment or .env; pass --db-url")
    # asyncpg needs postgres://, not postgresql:// or postgresql+asyncpg://
    url = url.replace("postgresql+asyncpg://", "postgres://")
    url = url.replace("postgresql://", "postgres://")
    return url


PIPELINE_QUERY = """
SELECT id, vault_id, status, current_phase, phase_status,
       error, updated_at, completed_at,
       active_task_id, active_task_type,
       compile_task_id, ingest_task_id
FROM pipeline_runs
WHERE id = $1::uuid
"""

ABSURD_TASK_QUERY = """
SELECT t.task_id, t.state AS task_state, t.attempts,
       t.max_attempts, t.first_started_at,
       r.run_id, r.state AS run_state, r.claimed_by,
       r.claim_expires_at, r.started_at, r.completed_at,
       r.failed_at, r.failure_reason,
       r.created_at
FROM absurd.t_default t
JOIN absurd.r_default r ON r.task_id = t.task_id
WHERE t.params->>'pipeline_run_id' = $1
ORDER BY r.created_at DESC
"""

ADVISORY_LOCKS_QUERY = """
SELECT pid, locktype, classid, objid, objsubid,
       mode, granted,
       pg_blocking_pids(pid) AS blocked_by
FROM pg_locks
WHERE locktype = 'advisory'
ORDER BY pid, objid
"""

ADVISORY_LOCK_FOR_VAULT_QUERY = """
SELECT pid, granted,
       pg_blocking_pids(pid) AS blocked_by
FROM pg_locks
WHERE locktype = 'advisory'
  AND classid = 0
  AND objid = (hashtextextended($1::text, 0) & x'FFFFFFFF'::bigint)::bigint
  AND objsubid = 2
"""

VAULT_LOCK_KEY_QUERY = """
SELECT hashtextextended($1::text, 0) AS lock_key_bigint
"""


def _fmt_ts(ts) -> str:
    if ts is None:
        return "—"
    return str(ts)[:19]


async def _diagnose(conn: asyncpg.Connection, pipeline_run_id: UUID, fix: bool) -> None:
    print("=" * 64)
    print(f"  Pipeline run: {pipeline_run_id}")
    print("=" * 64)

    # ── 1. Pipeline run state ──────────────────────────────────────
    row = await conn.fetchrow(PIPELINE_QUERY, pipeline_run_id)
    if row is None:
        sys.exit(f"\n  ERROR: No pipeline run found with id {pipeline_run_id}")

    vault_id = row["vault_id"]
    print("\n── Pipeline run ──")
    print(f"  vault_id:       {vault_id}")
    print(f"  status:         {row['status']}")
    print(f"  current_phase:  {row['current_phase']}")
    print(f"  phase_status:   {row['phase_status']}")
    print(f"  error:          {row['error'] or '—'}")
    print(f"  updated_at:     {_fmt_ts(row['updated_at'])}")
    print(f"  completed_at:   {_fmt_ts(row['completed_at'])}")
    print(f"  compile_task_id: {row['compile_task_id']}")
    print(f"  active_task_id:  {row['active_task_id']}")

    # ── 2. Absurd task/run state ───────────────────────────────────
    print("\n── Absurd compile task(s) ──")
    absurd_rows = await conn.fetch(ABSURD_TASK_QUERY, str(pipeline_run_id))
    if not absurd_rows:
        print("  (no Absurd tasks found for this pipeline run)")
    else:
        for i, ar in enumerate(absurd_rows):
            print(
                f"\n  Task  {ar['task_id']}  state={ar['task_state']}  attempts={ar['attempts']}/{ar['max_attempts']}"
            )
            print(f"    first_started: {_fmt_ts(ar['first_started_at'])}")
            print(f"  Run   {ar['run_id']}  state={ar['run_state']}")
            print(f"    claimed_by:    {ar['claimed_by'] or '—'}")
            print(f"    claim_expires: {_fmt_ts(ar['claim_expires_at'])}")
            print(f"    started:       {_fmt_ts(ar['started_at'])}")
            print(f"    completed:     {_fmt_ts(ar['completed_at'])}")
            print(f"    failed:        {_fmt_ts(ar['failed_at'])}")
            if ar["failure_reason"]:
                import json

                reason = ar["failure_reason"]
                if isinstance(reason, str):
                    reason = json.loads(reason) if reason.startswith("{") else reason
                print(f"    failure_reason: {reason}")

    # ── 3. Advisory locks ──────────────────────────────────────────
    print(f"\n── Advisory locks for vault {vault_id} ──")
    vault_lock = await conn.fetch(ADVISORY_LOCK_FOR_VAULT_QUERY, str(vault_id))
    if not vault_lock:
        print("  (no advisory lock held for this vault)")
    else:
        for lr in vault_lock:
            print(
                f"  pid={lr['pid']}  granted={lr['granted']}  blocked_by={lr['blocked_by'] or '—'}"
            )

    print("\n── All advisory locks ──")
    all_locks = await conn.fetch(ADVISORY_LOCKS_QUERY)
    if not all_locks:
        print("  (none)")
    else:
        for lr in all_locks:
            print(
                f"  pid={lr['pid']}  classid={lr['classid']}  objid={lr['objid']}  objsubid={lr['objsubid']}  "
                f"mode={lr['mode']}  granted={lr['granted']}  blocked_by={lr['blocked_by'] or '—'}"
            )

    # ── 4. Fix ─────────────────────────────────────────────────────
    if not fix:
        print("\nRun with --fix to release advisory lock + fail the pipeline run.")
        return

    print("\n── Applying fix ──")

    # 4a. Release advisory lock
    released = False
    for lr in vault_lock:
        if lr["granted"]:
            print(f"  Terminating backend pid={lr['pid']} to release lock...")
            await conn.execute("SELECT pg_terminate_backend($1::int)", lr["pid"])
            released = True

    if not released:
        print("  No advisory lock to release — trying unlock directly...")
        await conn.execute(
            "SELECT pg_advisory_unlock(hashtextextended($1::text, 0))",
            str(vault_id),
        )

    # 4b. Fail the pipeline run
    print("  Marking pipeline run as failed...")
    await conn.execute(
        """
        UPDATE pipeline_runs
        SET status = 'failed',
            error = 'Manually failed via diagnose_stuck_pipeline.py — stuck on compile lock',
            completed_at = now(),
            updated_at = now()
        WHERE id = $1::uuid
        """,
        pipeline_run_id,
    )

    # 4c. Cancel any still-active Absurd compile tasks
    for ar in absurd_rows:
        if ar["task_state"] in ("pending", "running", "sleeping"):
            print(
                f"  Cancelling Absurd task {ar['task_id']} (state={ar['task_state']})..."
            )
            await conn.execute(
                "SELECT absurd.cancel_task('default', $1::uuid)",
                ar["task_id"],
            )

    print("\n  ✓ Done. You can now re-trigger a compile from the UI.")
    print(
        "  The vault advisory lock should be free, and this pipeline run is marked failed."
    )


async def main() -> None:
    args = _parse_args()
    pipeline_run_id = UUID(args.pipeline_run_id)
    db_url = _db_url(args.db_url)

    conn = await asyncpg.connect(db_url)
    try:
        await _diagnose(conn, pipeline_run_id, args.fix)
    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
