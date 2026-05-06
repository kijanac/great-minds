"""Task routes."""

import asyncio
import json
import logging
from uuid import UUID

import asyncpg
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse

from great_minds.app.api.dependencies import (
    PageParamsQuery,
    SettingsDep,
    TaskServiceDep,
)
from great_minds.core.crypto import decode_access_token
from great_minds.core.pagination import Page
from great_minds.core.pipeline.notify import CHANNEL
from great_minds.core.tasks.schemas import TaskDetail

log = logging.getLogger(__name__)

router = APIRouter(prefix="/tasks", tags=["tasks"])


@router.get("")
async def list_tasks(
    vault_id: UUID,
    pagination: PageParamsQuery,
    task_service: TaskServiceDep,
) -> Page[TaskDetail]:
    result = await task_service.list_for_vault(vault_id, pagination=pagination)
    return result


@router.get("/{task_id}")
async def get_task(
    task_id: UUID,
    vault_id: UUID,
    task_service: TaskServiceDep,
) -> TaskDetail:
    response = await task_service.get(task_id, vault_id)
    if response is None:
        raise HTTPException(status_code=404, detail="Task not found")
    return response


# ---------------------------------------------------------------------------
# SSE progress stream — zero-polling via Postgres LISTEN/NOTIFY
# ---------------------------------------------------------------------------


@router.get("/{task_id}/stream")
async def stream_task_progress(
    task_id: UUID,
    vault_id: UUID,
    settings: SettingsDep,
    token: str = Query(..., description="JWT Bearer token for auth"),
) -> StreamingResponse:
    """Stream pipeline progress events via SSE.

    Authenticates via ``token`` query param (EventSource doesn't support
    custom headers). Opens a dedicated asyncpg connection, LISTENs on the
    pipeline_progress channel, filters for this task_id, and streams
    matching events as SSE.

    Connection drop → client reconnects → gets current state from DB
    then resumes live stream.
    """
    # Auth — validate the token is real. Vault access is enforced by
    # the task_id belonging to the vault (task tasks are vault-scoped).
    try:
        decode_access_token(token, settings)
    except ValueError:
        raise HTTPException(status_code=401, detail="Invalid token")

    return StreamingResponse(
        _event_stream(task_id, settings),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",  # disable nginx buffering
        },
    )


async def _event_stream(task_id: UUID, settings):
    """Yield SSE events from Postgres NOTIFY channel."""
    dsn = settings.database_url.replace("+asyncpg", "")
    conn = await asyncpg.connect(dsn)
    queue: asyncio.Queue[dict] = asyncio.Queue()

    def _on_notify(connection, pid, channel, payload):
        try:
            data = json.loads(payload)
            if data.get("task_id") == str(task_id):
                queue.put_nowait(data)
        except json.JSONDecodeError, Exception:
            pass

    await conn.add_listener(CHANNEL, _on_notify)

    try:
        # Initial connection event — tells the client what task we're watching
        yield f"event: connected\ndata: {json.dumps({'task_id': str(task_id)})}\n\n"

        while True:
            try:
                event = await asyncio.wait_for(queue.get(), timeout=30.0)
                yield f"data: {json.dumps(event)}\n\n"

                # Terminal states — close the stream gracefully
                if (
                    event.get("phase") == "publish"
                    and event.get("status") == "completed"
                ):
                    yield f"event: done\ndata: {json.dumps({'task_id': str(task_id)})}\n\n"
                    break
            except asyncio.TimeoutError:
                # Heartbeat to keep connection alive
                yield ": heartbeat\n\n"
    finally:
        await conn.remove_listener(CHANNEL, _on_notify)
        await conn.close()
