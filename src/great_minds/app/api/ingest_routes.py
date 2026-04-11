"""Ingest routes."""

from uuid import UUID

import httpx
from fastapi import APIRouter, Depends, HTTPException, UploadFile

from great_minds.app.api.dependencies import (
    get_brain_storage,
    get_ingest_service,
)
from great_minds.app.api.schemas import ingest as schemas
from great_minds.core.ingest_service import IngestService
from great_minds.core.storage import Storage

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
    )
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
        )
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=400, detail=f"Failed to fetch URL: {exc}")
    return schemas.IngestResponse(file_path=file_path, title=title)
