"""Pipeline run routes."""

import asyncio
import json
from uuid import UUID

import asyncpg
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
import httpx

from great_minds.app.api.dependencies import (
    DocumentRepositoryDep,
    PipelineRunServiceDep,
    SettingsDep,
    VaultStorageDep,
)
from great_minds.app.api.schemas.ingest import URLSource
from great_minds.core.documents.service import DocumentService
from great_minds.core.ingest_service import IngestService
from great_minds.core.pipeline_runs import PipelineRun, PipelineTrigger
from great_minds.core.pipeline_runs.repository import CHANNEL

router = APIRouter(prefix="/pipelines", tags=["pipelines"])


@router.post("/url", status_code=201)
async def start_url_pipeline(
    source: URLSource,
    vault_id: UUID,
    storage: VaultStorageDep,
    doc_repo: DocumentRepositoryDep,
    pipeline_service: PipelineRunServiceDep,
) -> PipelineRun:
    run = await pipeline_service.create(vault_id=vault_id, trigger=PipelineTrigger.URL)
    await pipeline_service.repo.update_progress(
        run.id,
        phase="bulk_ingest",
        status="started",
        done=0,
        total=1,
        message="fetching source URL",
    )
    ingest_service = IngestService(DocumentService(doc_repo, pipeline_run_id=run.id))
    try:
        await ingest_service.ingest_url(vault_id, storage, source.url, source.metadata)
    except Exception as exc:
        message = (
            f"Failed to fetch URL: {exc}"
            if isinstance(exc, httpx.HTTPError)
            else str(exc)
        )
        await pipeline_service.repo.update_progress(
            run.id,
            phase="bulk_ingest",
            status="failed",
            error=message,
        )
        await pipeline_service.repo.notify_changed(
            pipeline_run_id=run.id,
            vault_id=vault_id,
        )
        await pipeline_service.repo.session.commit()
        if isinstance(exc, httpx.HTTPError):
            raise HTTPException(status_code=400, detail=message) from exc
        raise
    await pipeline_service.repo.update_progress(
        run.id,
        phase="bulk_ingest",
        status="completed",
        done=1,
        total=1,
        message="source prepared for compile",
    )
    await pipeline_service.repo.notify_changed(
        pipeline_run_id=run.id,
        vault_id=vault_id,
    )
    await pipeline_service.repo.session.commit()
    refreshed = await pipeline_service.get(run.id, vault_id)
    if refreshed is None:
        raise HTTPException(status_code=404, detail="Pipeline run not found")
    return refreshed


@router.get("/current")
async def get_current_pipeline(
    vault_id: UUID,
    pipeline_service: PipelineRunServiceDep,
) -> PipelineRun:
    run = await pipeline_service.get_current_for_vault(vault_id)
    if run is None:
        raise HTTPException(status_code=404, detail="No pipeline run found")
    return run


@router.get("/{pipeline_run_id}")
async def get_pipeline(
    pipeline_run_id: UUID,
    vault_id: UUID,
    pipeline_service: PipelineRunServiceDep,
) -> PipelineRun:
    run = await pipeline_service.get(pipeline_run_id, vault_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Pipeline run not found")
    return run


@router.get("/{pipeline_run_id}/stream")
async def stream_pipeline_progress(
    pipeline_run_id: UUID,
    vault_id: UUID,
    settings: SettingsDep,
    pipeline_service: PipelineRunServiceDep,
) -> StreamingResponse:
    run = await pipeline_service.get(pipeline_run_id, vault_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Pipeline run not found")

    return StreamingResponse(
        _event_stream(pipeline_run_id, vault_id, settings),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


async def _event_stream(pipeline_run_id: UUID, vault_id: UUID, settings):
    """Yield durable pipeline snapshots, woken by Postgres NOTIFY."""
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
                   bulk_task_id,
                   compile_intent_id,
                   compile_task_id,
                   updated_at,
                   completed_at
            FROM pipeline_runs
            WHERE id = $1 AND vault_id = $2
            """,
            pipeline_run_id,
            vault_id,
        )
        if row is None:
            return None
        return {
            "pipeline_run_id": str(row["id"]),
            "vault_id": str(row["vault_id"]),
            "trigger": row["trigger"],
            "run_status": row["status"],
            "phase": row["current_phase"],
            "status": row["phase_status"],
            "done": row["progress_done"],
            "total": row["progress_total"],
            "failed": row["progress_failed"],
            "message": row["progress_message"],
            "error": row["error"],
            "bulk_task_id": str(row["bulk_task_id"]) if row["bulk_task_id"] else None,
            "compile_intent_id": str(row["compile_intent_id"])
            if row["compile_intent_id"]
            else None,
            "compile_task_id": str(row["compile_task_id"])
            if row["compile_task_id"]
            else None,
            "updated_at": row["updated_at"].isoformat() if row["updated_at"] else None,
            "completed_at": row["completed_at"].isoformat()
            if row["completed_at"]
            else None,
        }

    def _on_notify(connection, pid, channel, payload):
        del connection, pid, channel
        try:
            data = json.loads(payload)
            if data.get("pipeline_run_id") == str(pipeline_run_id) and data.get(
                "vault_id"
            ) == str(vault_id):
                queue.put_nowait(data)
        except json.JSONDecodeError:
            pass

    await conn.add_listener(CHANNEL, _on_notify)

    try:
        yield (
            "event: connected\n"
            f"data: {json.dumps({'pipeline_run_id': str(pipeline_run_id)})}\n\n"
        )

        initial = await snapshot()
        if initial is not None:
            yield f"data: {json.dumps(initial)}\n\n"
            if initial.get("run_status") in {"completed", "failed", "cancelled"}:
                yield (
                    "event: done\n"
                    f"data: {json.dumps({'pipeline_run_id': str(pipeline_run_id)})}\n\n"
                )
                return

        while True:
            try:
                await asyncio.wait_for(queue.get(), timeout=30.0)
                current = await snapshot()
                if current is None:
                    continue
                yield f"data: {json.dumps(current)}\n\n"
                if current.get("run_status") in {"completed", "failed", "cancelled"}:
                    yield (
                        "event: done\n"
                        f"data: {json.dumps({'pipeline_run_id': str(pipeline_run_id)})}\n\n"
                    )
                    break
            except asyncio.TimeoutError:
                yield ": heartbeat\n\n"
    finally:
        await conn.remove_listener(CHANNEL, _on_notify)
        await conn.close()
