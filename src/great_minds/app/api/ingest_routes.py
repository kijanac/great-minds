"""Ingest routes."""

import logging
from uuid import UUID

import httpx
from fastapi import APIRouter, HTTPException, UploadFile, status

from great_minds.app.api.dependencies import (
    VaultStorageDep,
    IngestServiceDep,
    PipelineRunServiceDep,
)
from great_minds.app.api.schemas.ingest import (
    StagedFileProcessRequest,
    StagedFileSignRequest,
    StagedFileSignResponse,
    IngestResult,
    RawSource,
    URLSource,
    UserSuggestion,
)
from great_minds.app.api.schemas.jobs import JobResponse
from great_minds.core.documents.schemas import SourceMetadata

log = logging.getLogger(__name__)

router = APIRouter(prefix="/ingest", tags=["ingest"])


@router.post("", status_code=201)
async def ingest(
    source: RawSource,
    vault_id: UUID,
    storage: VaultStorageDep,
    ingest_service: IngestServiceDep,
) -> IngestResult:
    result = await ingest_service.ingest_text(
        vault_id,
        storage,
        source.content,
        source.dest,
        source.metadata,
    )
    return IngestResult(
        file_path=result.file_path,
        title=result.title,
    )


@router.post("/user-suggestion", status_code=201)
async def ingest_user_suggestion(
    suggestion: UserSuggestion,
    vault_id: UUID,
    storage: VaultStorageDep,
    ingest_service: IngestServiceDep,
) -> IngestResult:
    try:
        result = await ingest_service.ingest_user_suggestion(
            vault_id,
            storage,
            body=suggestion.body,
            intent=suggestion.intent,
            anchored_to=suggestion.anchored_to,
            anchored_section=suggestion.anchored_section,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return IngestResult(
        file_path=result.file_path,
        title=result.title,
    )


@router.post("/upload", status_code=201)
async def ingest_upload(
    file: UploadFile,
    vault_id: UUID,
    storage: VaultStorageDep,
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
        raise HTTPException(
            status_code=400, detail="Uploaded file must have a filename"
        )
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
        result = await ingest_service.ingest_upload(
            vault_id,
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
    return IngestResult(
        file_path=result.file_path,
        title=result.title,
    )


@router.post("/url", status_code=201)
async def ingest_url(
    source: URLSource,
    vault_id: UUID,
    storage: VaultStorageDep,
    ingest_service: IngestServiceDep,
) -> IngestResult:
    try:
        result = await ingest_service.ingest_url(
            vault_id,
            storage,
            source.url,
            source.metadata,
        )
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=400, detail=f"Failed to fetch URL: {exc}")
    return IngestResult(
        file_path=result.file_path,
        title=result.title,
    )


# ---------------------------------------------------------------------------
# Staged direct-to-R2 upload flow
#
# Two-step handshake: client posts a manifest and gets back presigned PUT
# URLs, uploads each file directly to ``staging/<vault>/<hash>`` on R2,
# then posts the hashes to /process which spawns a worker. Server never
# sees file bytes — sidesteps multipart caps, BaseHTTPMiddleware
# disconnects, and per-request memory pressure entirely.
# ---------------------------------------------------------------------------


@router.post("/bulk/sign", include_in_schema=False)
@router.post("/staged-files/sign")
async def ingest_staged_files_sign(
    req: StagedFileSignRequest,
    vault_id: UUID,
    ingest_service: IngestServiceDep,
) -> StagedFileSignResponse:
    try:
        signed = await ingest_service.sign_staged_files(vault_id, req.files)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return StagedFileSignResponse(files=signed)


@router.post("/bulk/process", include_in_schema=False)
@router.post("/staged-files/process")
async def ingest_staged_files_process(
    req: StagedFileProcessRequest,
    vault_id: UUID,
    pipeline_service: PipelineRunServiceDep,
) -> JobResponse:
    try:
        run = await pipeline_service.start_staged_file_ingest(
            vault_id=vault_id,
            job_id=req.job_id,
            files=req.files,
            content_type=req.content_type,
            source_type=req.source_type,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Pipeline run could not be reloaded after creation",
        ) from exc
    return JobResponse.model_validate(run)
