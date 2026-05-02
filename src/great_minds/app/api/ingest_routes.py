"""Ingest routes."""

import logging
from uuid import UUID

import httpx
from fastapi import APIRouter, HTTPException, UploadFile

from great_minds.app.api.dependencies import (
    BrainServiceDep,
    BrainStorageDep,
    IngestServiceDep,
    SettingsDep,
    TaskServiceDep,
)
from great_minds.app.api.schemas.ingest import (
    BulkProcessRequest,
    BulkProcessResponse,
    BulkSignedUrl,
    BulkSignRequest,
    BulkSignResponse,
    IngestResult,
    RawSource,
    URLSource,
    UserSuggestion,
)
from great_minds.core.documents.schemas import SourceMetadata
from great_minds.core.r2_admin import R2Admin

log = logging.getLogger(__name__)

router = APIRouter(prefix="/ingest", tags=["ingest"])


@router.post("", status_code=201)
async def ingest(
    source: RawSource,
    brain_id: UUID,
    storage: BrainStorageDep,
    ingest_service: IngestServiceDep,
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
    ingest_service: IngestServiceDep,
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
    ingest_service: IngestServiceDep,
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
    ingest_service: IngestServiceDep,
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


# ---------------------------------------------------------------------------
# Bulk direct-to-R2 upload flow
#
# Two-step handshake: client posts a manifest and gets back presigned PUT
# URLs, uploads each file directly to ``staging/<brain>/<hash>`` on R2,
# then posts the hashes to /process which spawns a worker. Server never
# sees file bytes — sidesteps multipart caps, BaseHTTPMiddleware
# disconnects, and per-request memory pressure entirely.
# ---------------------------------------------------------------------------


@router.post("/bulk/sign")
async def ingest_bulk_sign(
    req: BulkSignRequest,
    brain_id: UUID,
    brain_service: BrainServiceDep,
    settings: SettingsDep,
) -> BulkSignResponse:
    if settings.storage_backend != "r2":
        raise HTTPException(
            status_code=400,
            detail="bulk upload requires r2 storage backend",
        )
    brain = await brain_service.get_brain(brain_id)
    if not brain.r2_bucket_name:
        raise HTTPException(
            status_code=400,
            detail="brain has no r2 bucket; cannot sign uploads",
        )
    if not req.files:
        raise HTTPException(status_code=400, detail="manifest is empty")

    admin = R2Admin(
        account_id=settings.r2_account_id,
        access_key_id=settings.r2_access_key_id,
        secret_access_key=settings.r2_secret_access_key,
    )
    signed: list[BulkSignedUrl] = []
    for f in req.files:
        key = f"staging/{brain_id}/{f.hash}"
        url = admin.presign_put(
            brain.r2_bucket_name,
            key,
            content_type=f.mimetype or "application/octet-stream",
            content_length=f.size,
        )
        signed.append(BulkSignedUrl(hash=f.hash, url=url))
    return BulkSignResponse(files=signed)


@router.post("/bulk/process")
async def ingest_bulk_process(
    req: BulkProcessRequest,
    brain_id: UUID,
    task_service: TaskServiceDep,
) -> BulkProcessResponse:
    if not req.files:
        raise HTTPException(status_code=400, detail="no files provided")
    detail = await task_service.spawn_bulk_ingest_from_staging(
        brain_id=brain_id,
        files=[f.model_dump() for f in req.files],
        content_type=req.content_type,
        source_type=req.source_type,
    )
    return BulkProcessResponse(task_id=str(detail.id))
