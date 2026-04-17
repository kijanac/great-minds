"""Ingest routes."""

import json
import logging
from collections.abc import AsyncIterator
from dataclasses import asdict
from uuid import UUID

import httpx
from fastapi import APIRouter, Depends, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse

from great_minds.app.api.dependencies import (
    get_brain_service,
    get_brain_storage,
    get_ingest_service,
    get_task_service,
    require_brain_member,
)
from great_minds.app.api.schemas import ingest as schemas
from great_minds.core.brains.service import BrainService
from great_minds.core.ingest_service import (
    BulkFileInput,
    BulkFileStatus,
    IngestService,
)
from great_minds.core.settings import Settings, get_settings
from great_minds.core.storage import Storage
from great_minds.core.tasks.service import TaskService

log = logging.getLogger(__name__)

router = APIRouter(prefix="/ingest", tags=["ingest"])


@router.post("", status_code=201)
async def ingest(
    req: schemas.IngestRequest,
    brain_id: UUID,
    storage: Storage = Depends(get_brain_storage),
    ingest_service: IngestService = Depends(get_ingest_service),
) -> schemas.IngestResponse:
    file_path, title = await ingest_service.ingest_text(
        brain_id,
        storage,
        req.content,
        req.content_type,
        req.dest,
        title=req.title,
        author=req.author,
        date=req.published_date,
        origin=req.origin,
        url=req.url,
        source_type=req.source_type,
    )
    return schemas.IngestResponse(file_path=file_path, title=title)


@router.post("/user-suggestion", status_code=201)
async def ingest_user_suggestion(
    req: schemas.UserSuggestionRequest,
    brain_id: UUID,
    storage: Storage = Depends(get_brain_storage),
    ingest_service: IngestService = Depends(get_ingest_service),
    _auth: None = Depends(require_brain_member),
) -> schemas.IngestResponse:
    try:
        file_path, title = await ingest_service.ingest_user_suggestion(
            brain_id,
            storage,
            body=req.body,
            intent=req.intent,
            anchored_to=req.anchored_to,
            anchored_section=req.anchored_section,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return schemas.IngestResponse(file_path=file_path, title=title)


@router.post("/upload", status_code=201)
async def ingest_upload(
    file: UploadFile,
    brain_id: UUID,
    storage: Storage = Depends(get_brain_storage),
    ingest_service: IngestService = Depends(get_ingest_service),
    content_type: str = "texts",
    author: str | None = None,
    date: str | None = None,
    origin: str | None = None,
    url: str | None = None,
    dest_path: str | None = None,
    source_type: str = "document",
) -> schemas.IngestResponse:
    raw_bytes = await file.read()
    filename = file.filename or "upload.md"
    try:
        file_path, title = await ingest_service.ingest_upload(
            brain_id,
            storage,
            raw_bytes,
            filename,
            content_type,
            mimetype=file.content_type or "",
            author=author,
            date=date,
            origin=origin,
            url=url,
            dest_path=dest_path,
            source_type=source_type,
        )
    except UnicodeDecodeError:
        raise HTTPException(
            status_code=400, detail=f"File is not valid UTF-8: {filename}"
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return schemas.IngestResponse(file_path=file_path, title=title)


@router.post("/url", status_code=201)
async def ingest_url(
    req: schemas.IngestUrlRequest,
    brain_id: UUID,
    storage: Storage = Depends(get_brain_storage),
    ingest_service: IngestService = Depends(get_ingest_service),
) -> schemas.IngestResponse:
    try:
        file_path, title = await ingest_service.ingest_url(
            brain_id,
            storage,
            req.url,
            req.content_type,
            source_type=req.source_type,
        )
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=400, detail=f"Failed to fetch URL: {exc}")
    return schemas.IngestResponse(file_path=file_path, title=title)


@router.post("/bulk")
async def ingest_bulk(
    brain_id: UUID,
    files: list[UploadFile],
    content_type: str = Form("texts"),
    storage: Storage = Depends(get_brain_storage),
    ingest_service: IngestService = Depends(get_ingest_service),
    task_service: TaskService = Depends(get_task_service),
    brain_service: BrainService = Depends(get_brain_service),
    settings: Settings = Depends(get_settings),
    _auth: None = Depends(require_brain_member),
) -> StreamingResponse:
    """Bulk ingest N files. Streams NDJSON per-file events, triggers compile at end."""
    bulk_inputs = [
        BulkFileInput(
            filename=f.filename or f"upload-{i}.md",
            raw_bytes=await f.read(),
            mimetype=f.content_type or "",
        )
        for i, f in enumerate(files)
    ]
    brain = await brain_service.get_by_id(brain_id)

    return StreamingResponse(
        _stream_bulk_events(
            brain_id=brain_id,
            brain_name=brain.name,
            data_dir=settings.data_dir,
            bulk_inputs=bulk_inputs,
            content_type=content_type,
            storage=storage,
            ingest_service=ingest_service,
            task_service=task_service,
        ),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


async def _stream_bulk_events(
    *,
    brain_id: UUID,
    brain_name: str,
    data_dir: str,
    bulk_inputs: list[BulkFileInput],
    content_type: str,
    storage: Storage,
    ingest_service: IngestService,
    task_service: TaskService,
) -> AsyncIterator[str]:
    yield json.dumps({"event": "start", "total": len(bulk_inputs)}) + "\n"

    ingested = 0
    skipped = 0
    failed = 0
    async for event in ingest_service.ingest_bulk(
        brain_id, storage, bulk_inputs, content_type
    ):
        if event.status == BulkFileStatus.DONE:
            ingested += 1
        elif event.status == BulkFileStatus.SKIPPED:
            skipped += 1
        else:
            failed += 1
        payload = {**asdict(event), "event": "file", "status": event.status.value}
        yield json.dumps(payload) + "\n"

    compile_spawned = False
    if ingested > 0:
        try:
            await task_service.spawn_compile(
                brain_id=brain_id, data_dir=data_dir, label=brain_name
            )
            compile_spawned = True
        except Exception as exc:
            log.exception("failed to spawn compile after bulk ingest: %s", exc)

    yield (
        json.dumps(
            {
                "event": "done",
                "ingested": ingested,
                "skipped": skipped,
                "failed": failed,
                "compile_spawned": compile_spawned,
            }
        )
        + "\n"
    )
