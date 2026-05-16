"""Ingest routes."""

import logging
from uuid import UUID

import httpx
from fastapi import APIRouter, HTTPException, UploadFile, status

from great_minds.app.api.dependencies import (
    IngestServiceDep,
    PipelineRunServiceDep,
    SourceDocumentServiceDep,
    VaultStorageDep,
)
from great_minds.app.api.schemas.ingest import (
    CheckDupesRequest,
    CheckDupesResponse,
    RawSource,
    StagedFileProcessRequest,
    StagedFileSignRequest,
    StagedFileSignResponse,
    URLSource,
    UserSuggestion,
)
from great_minds.app.api.schemas.jobs import JobResponse
from great_minds.core.documents.schemas import IngestedDocument

log = logging.getLogger(__name__)

router = APIRouter(prefix="/ingest", tags=["ingest"])


@router.post("", status_code=201)
async def ingest(
    source: RawSource,
    vault_id: UUID,
    storage: VaultStorageDep,
    ingest_service: IngestServiceDep,
) -> IngestedDocument:
    return await ingest_service.ingest_text(
        vault_id,
        storage,
        content=source.content,
        dest=source.dest,
        origin=source.origin,
    )


@router.post("/user-suggestion", status_code=201)
async def ingest_user_suggestion(
    suggestion: UserSuggestion,
    vault_id: UUID,
    storage: VaultStorageDep,
    ingest_service: IngestServiceDep,
) -> IngestedDocument:
    try:
        return await ingest_service.ingest_user_suggestion(
            vault_id,
            storage,
            body=suggestion.body,
            intent=suggestion.intent,
            anchored_to=suggestion.anchored_to,
            anchored_section=suggestion.anchored_section,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/upload", status_code=201)
async def ingest_upload(
    file: UploadFile,
    vault_id: UUID,
    storage: VaultStorageDep,
    ingest_service: IngestServiceDep,
    origin: str | None = None,
    dest_path: str | None = None,
) -> IngestedDocument:
    raw_bytes = await file.read()
    if not file.filename:
        raise HTTPException(
            status_code=400, detail="Uploaded file must have a filename"
        )
    try:
        return await ingest_service.ingest_upload(
            vault_id,
            storage,
            raw_bytes=raw_bytes,
            filename=file.filename,
            mimetype=file.content_type or "",
            dest_path=dest_path,
            origin=origin,
        )
    except UnicodeDecodeError:
        raise HTTPException(
            status_code=400, detail=f"File is not valid UTF-8: {file.filename}"
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/url", status_code=201)
async def ingest_url(
    source: URLSource,
    vault_id: UUID,
    storage: VaultStorageDep,
    ingest_service: IngestServiceDep,
) -> IngestedDocument:
    try:
        return await ingest_service.ingest_url(
            vault_id,
            storage,
            url=source.url,
            origin=source.origin,
        )
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=400, detail=f"Failed to fetch URL: {exc}")


# ---------------------------------------------------------------------------
# Staged direct-to-R2 upload flow
#
# Two-step handshake: client posts a manifest and gets back presigned PUT
# URLs, uploads each file directly to ``staging/<vault>/<hash>`` on R2,
# then posts the hashes to /process which spawns a worker. Server never
# sees file bytes — sidesteps multipart caps, BaseHTTPMiddleware
# disconnects, and per-request memory pressure entirely.
# ---------------------------------------------------------------------------


@router.post("/staged-files/check-dupes")
async def ingest_staged_files_check_dupes(
    req: CheckDupesRequest,
    vault_id: UUID,
    doc_service: SourceDocumentServiceDep,
) -> CheckDupesResponse:
    """Return the subset of submitted client-hashes that already exist in this vault.

    The frontend hashes files at pick-time (``sha256`` of the raw
    bytes) and calls this before showing the staged-upload preview so
    rows can be styled with "already in vault" status.
    """
    existing = await doc_service.existing_client_hashes(vault_id, req.client_hashes)
    return CheckDupesResponse(existing=existing)


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
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Pipeline run could not be reloaded after creation",
        ) from exc
    return JobResponse.model_validate(run)
