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
    get_brain_storage,
    get_compile_intent_repository,
    get_ingest_service,
    require_brain_member,
)
from great_minds.app.api.schemas import ingest as schemas
from great_minds.core.ingest_service import (
    BulkFileInput,
    BulkFileStatus,
    IngestService,
)
from great_minds.core.compile_intents.repository import CompileIntentRepository
from great_minds.core.storage import Storage
from great_minds.core.telemetry import log_event

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
    intent_repo: CompileIntentRepository = Depends(get_compile_intent_repository),
    _auth: None = Depends(require_brain_member),
) -> StreamingResponse:
    """Bulk ingest N files. Streams NDJSON per-file events; on success writes
    a compile intent (reconciler dispatches to Absurd within ~5s).
    """
    bulk_inputs = [
        BulkFileInput(
            filename=f.filename or f"upload-{i}.md",
            raw_bytes=await f.read(),
            mimetype=f.content_type or "",
        )
        for i, f in enumerate(files)
    ]

    return StreamingResponse(
        _stream_bulk_events(
            brain_id=brain_id,
            bulk_inputs=bulk_inputs,
            content_type=content_type,
            storage=storage,
            ingest_service=ingest_service,
            intent_repo=intent_repo,
        ),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


async def _stream_bulk_events(
    *,
    brain_id: UUID,
    bulk_inputs: list[BulkFileInput],
    content_type: str,
    storage: Storage,
    ingest_service: IngestService,
    intent_repo: CompileIntentRepository,
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

    intent_id: str | None = None
    if ingested > 0:
        intent = await intent_repo.upsert_pending(brain_id)
        if intent is None:
            # Coalesced into an existing pending intent — return its id so
            # the frontend can poll the same one.
            intent = await intent_repo.get_pending_for_brain(brain_id)
        await intent_repo.session.commit()
        if intent is not None:
            intent_id = str(intent.id)
            log_event(
                "intent_created",
                intent_id=intent_id,
                brain_id=str(brain_id),
                trigger="bulk_ingest",
            )

    yield (
        json.dumps(
            {
                "event": "done",
                "ingested": ingested,
                "skipped": skipped,
                "failed": failed,
                "compile_intent_id": intent_id,
            }
        )
        + "\n"
    )
