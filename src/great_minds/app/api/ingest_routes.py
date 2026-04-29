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
    BrainMemberGuard,
    BrainStorageDep,
    get_compile_intent_repository,
    get_ingest_service,
)
from great_minds.app.api.schemas.ingest import (
    IngestResult,
    RawSource,
    URLSource,
    UserSuggestion,
)
from great_minds.core.ingest_service import (
    BulkFileInput,
    BulkFileStatus,
    IngestService,
)
from great_minds.core.compile_intents import CompileIntentRepository
from great_minds.core.sources import SourceMetadata
from great_minds.core.storage import Storage
from great_minds.core.telemetry import log_event

log = logging.getLogger(__name__)

router = APIRouter(prefix="/ingest", tags=["ingest"])


@router.post("", status_code=201)
async def ingest(
    source: RawSource,
    brain_id: UUID,
    storage: BrainStorageDep,
    ingest_service: IngestService = Depends(get_ingest_service),
) -> IngestResult:
    file_path, title = await ingest_service.ingest_text(
        brain_id,
        storage,
        source.content,
        source.dest,
        source.metadata,
    )
    return IngestResult(file_path=file_path, title=title)


@router.post("/user-suggestion", status_code=201)
async def ingest_user_suggestion(
    suggestion: UserSuggestion,
    brain_id: UUID,
    storage: BrainStorageDep,
    _auth: BrainMemberGuard,
    ingest_service: IngestService = Depends(get_ingest_service),
) -> IngestResult:
    try:
        file_path, title = await ingest_service.ingest_user_suggestion(
            brain_id,
            storage,
            body=suggestion.body,
            intent=suggestion.intent,
            anchored_to=suggestion.anchored_to,
            anchored_section=suggestion.anchored_section,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return IngestResult(file_path=file_path, title=title)


@router.post("/upload", status_code=201)
async def ingest_upload(
    file: UploadFile,
    brain_id: UUID,
    storage: BrainStorageDep,
    ingest_service: IngestService = Depends(get_ingest_service),
    content_type: str = "texts",
    author: str | None = None,
    date: str | None = None,
    origin: str | None = None,
    url: str | None = None,
    dest_path: str | None = None,
    source_type: str = "document",
) -> IngestResult:
    raw_bytes = await file.read()
    if not file.filename:
        raise HTTPException(status_code=400, detail="Uploaded file must have a filename")
    filename = file.filename
    metadata = SourceMetadata(
        content_type=content_type,
        source_type=source_type,
        author=author,
        published_date=date,
        origin=origin,
        url=url,
    )
    try:
        file_path, title = await ingest_service.ingest_upload(
            brain_id,
            storage,
            raw_bytes,
            filename,
            metadata,
            mimetype=file.content_type or "",
            dest_path=dest_path,
        )
    except UnicodeDecodeError:
        raise HTTPException(
            status_code=400, detail=f"File is not valid UTF-8: {filename}"
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return IngestResult(file_path=file_path, title=title)


@router.post("/url", status_code=201)
async def ingest_url(
    source: URLSource,
    brain_id: UUID,
    storage: BrainStorageDep,
    ingest_service: IngestService = Depends(get_ingest_service),
) -> IngestResult:
    try:
        file_path, title = await ingest_service.ingest_url(
            brain_id,
            storage,
            source.url,
            source.metadata,
        )
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=400, detail=f"Failed to fetch URL: {exc}")
    return IngestResult(file_path=file_path, title=title)


@router.post("/bulk")
async def ingest_bulk(
    brain_id: UUID,
    files: list[UploadFile],
    storage: BrainStorageDep,
    _auth: BrainMemberGuard,
    content_type: str = Form("texts"),
    ingest_service: IngestService = Depends(get_ingest_service),
    intent_repo: CompileIntentRepository = Depends(get_compile_intent_repository),
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
