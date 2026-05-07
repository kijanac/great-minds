"""Job routes backed by pipeline run records."""

import asyncio
import json
from uuid import UUID

import asyncpg
from fastapi import APIRouter, HTTPException, status
from fastapi.responses import StreamingResponse

from great_minds.app.api.dependencies import (
    JobServiceDep,
    PageParamsQuery,
    PipelineRunServiceDep,
    SettingsDep,
    VaultStorageDep,
)
from great_minds.app.api.schemas.ingest import URLSource
from great_minds.app.api.schemas.jobs import JobResponse
from great_minds.core.jobs import JobNotFoundError, UrlJobSourceError
from great_minds.core.pagination import Page
from great_minds.core.pipeline_runs.repository import CHANNEL

router = APIRouter(prefix="/jobs", tags=["jobs"])


@router.post("/url", status_code=201)
async def start_url_pipeline(
    source: URLSource,
    vault_id: UUID,
    storage: VaultStorageDep,
    job_service: JobServiceDep,
) -> JobResponse:
    try:
        run = await job_service.start_url_job(
            vault_id=vault_id,
            storage=storage,
            job_id=source.job_id,
            url=source.url,
            metadata=source.metadata,
        )
    except UrlJobSourceError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except JobNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Job could not be reloaded after creation",
        ) from exc
    return JobResponse.model_validate(run)


@router.get("")
async def list_jobs(
    vault_id: UUID,
    pipeline_service: PipelineRunServiceDep,
    pagination: PageParamsQuery,
    status: str | None = None,
) -> Page[JobResponse]:
    page = await pipeline_service.list_for_vault(
        vault_id, status=status, pagination=pagination
    )
    return Page(
        items=[JobResponse.model_validate(run) for run in page.items],
        pagination=page.pagination,
    )


@router.get("/{job_id}")
async def get_pipeline(
    job_id: UUID,
    vault_id: UUID,
    pipeline_service: PipelineRunServiceDep,
) -> JobResponse:
    run = await pipeline_service.get(job_id, vault_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Job not found")
    return JobResponse.model_validate(run)


@router.get("/{job_id}/stream")
async def stream_pipeline_progress(
    job_id: UUID,
    vault_id: UUID,
    settings: SettingsDep,
    pipeline_service: PipelineRunServiceDep,
) -> StreamingResponse:
    run = await pipeline_service.get(job_id, vault_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Job not found")

    return StreamingResponse(
        _event_stream(job_id, vault_id, settings),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


async def _event_stream(job_id: UUID, vault_id: UUID, settings):
    """Yield durable job snapshots, woken by Postgres NOTIFY."""
    dsn = settings.database_url.replace("+asyncpg", "")
    conn = await asyncpg.connect(dsn)
    queue: asyncio.Queue[dict] = asyncio.Queue()

    async def snapshot() -> dict | None:
        row = await conn.fetchrow(
            """
            SELECT id,
                   vault_id,
                   trigger,
                   status,
                   current_phase,
                   phase_status,
                   progress_done,
                   progress_total,
                   progress_failed,
                   progress_message,
                   error,
                   updated_at,
                   completed_at
            FROM pipeline_runs
            WHERE id = $1 AND vault_id = $2
            """,
            job_id,
            vault_id,
        )
        if row is None:
            return None
        return {
            "id": str(row["id"]),
            "vault_id": str(row["vault_id"]),
            "trigger": row["trigger"],
            "job_status": row["status"],
            "phase": row["current_phase"],
            "status": row["phase_status"],
            "done": row["progress_done"],
            "total": row["progress_total"],
            "failed": row["progress_failed"],
            "message": row["progress_message"],
            "error": row["error"],
            "updated_at": row["updated_at"].isoformat() if row["updated_at"] else None,
            "completed_at": row["completed_at"].isoformat()
            if row["completed_at"]
            else None,
        }

    def _on_notify(connection, pid, channel, payload):
        del connection, pid, channel
        try:
            data = json.loads(payload)
            if data.get("pipeline_run_id") == str(job_id) and data.get(
                "vault_id"
            ) == str(vault_id):
                queue.put_nowait(data)
        except json.JSONDecodeError:
            pass

    await conn.add_listener(CHANNEL, _on_notify)

    try:
        yield (f"event: connected\ndata: {json.dumps({'id': str(job_id)})}\n\n")

        initial = await snapshot()
        if initial is not None:
            yield f"data: {json.dumps(initial)}\n\n"
            if initial.get("job_status") in {"completed", "failed", "cancelled"}:
                yield (f"event: done\ndata: {json.dumps({'id': str(job_id)})}\n\n")
                return

        while True:
            try:
                await asyncio.wait_for(queue.get(), timeout=30.0)
                current = await snapshot()
                if current is None:
                    continue
                yield f"data: {json.dumps(current)}\n\n"
                if current.get("job_status") in {"completed", "failed", "cancelled"}:
                    yield (f"event: done\ndata: {json.dumps({'id': str(job_id)})}\n\n")
                    break
            except asyncio.TimeoutError:
                yield ": heartbeat\n\n"
    finally:
        await conn.remove_listener(CHANNEL, _on_notify)
        await conn.close()
