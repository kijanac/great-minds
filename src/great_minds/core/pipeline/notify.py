"""Pipeline progress via Postgres LISTEN/NOTIFY.

Workers emit NOTIFY events as they complete pipeline phases. An SSE
endpoint LISTENs and forwards matching events to the frontend. No
polling anywhere — the worker pushes, the server receives via asyncpg
notification, the client receives via EventSource.

Each notification uses a short-lived dedicated asyncpg connection to
sidestep SQLAlchemy's transaction-bound session. pg_notify fires
immediately regardless of transaction state.
"""

import json
from uuid import UUID

import asyncpg

from great_minds.core.settings import get_settings

CHANNEL = "pipeline_progress"


async def notify(
    *,
    task_id: UUID,
    phase: str,
    status: str,  # "started" | "progress" | "completed" | "failed"
    done: int = 0,
    total: int = 0,
    error: str | None = None,
    **extra,
) -> None:
    """Emit a pipeline progress notification on the shared channel.

    Each notification carries the task_id so the SSE endpoint can filter
    to the correct stream. Extra kwargs become top-level JSON fields
    (e.g. docs_failed, ideas_emitted for phase summaries).
    """
    payload = {
        "task_id": str(task_id),
        "phase": phase,
        "status": status,
        "done": done,
        "total": total,
    }
    if error is not None:
        payload["error"] = error
    payload.update(extra)

    settings = get_settings()
    dsn = settings.database_url.replace("+asyncpg", "")
    conn = await asyncpg.connect(dsn)
    try:
        await conn.execute(
            "SELECT pg_notify($1, $2)",
            CHANNEL,
            json.dumps(payload),
        )
    finally:
        await conn.close()
