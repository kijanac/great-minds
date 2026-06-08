"""Ingest request/response schemas."""

from uuid import UUID

from pydantic import BaseModel

from great_minds.core.ingest_schemas import (
    LocalFileInput,
    StagedFileInput,
    StagedFileSignedUpload,
)
from great_minds.core.ingest_service import UserSuggestionIntent


class RawSource(BaseModel):
    content: str
    dest: str
    origin: str | None = None


class URLSource(BaseModel):
    job_id: UUID
    url: str
    origin: str | None = None


class UserSuggestion(BaseModel):
    body: str
    intent: UserSuggestionIntent
    anchored_to: str = ""
    anchored_section: str = ""


# ---------------------------------------------------------------------------
# Staged direct-to-R2 upload flow
# ---------------------------------------------------------------------------


class StagedFileSignRequest(BaseModel):
    files: list[StagedFileInput]


class StagedFileSignResponse(BaseModel):
    files: list[StagedFileSignedUpload]


class StagedFileProcessRequest(BaseModel):
    job_id: UUID
    files: list[StagedFileInput]


class CheckDupesRequest(BaseModel):
    """Pre-flight: which of these client-side hashes already exist in this vault?"""

    client_hashes: list[str]


class CheckDupesResponse(BaseModel):
    existing: list[str]


class LocalFileManifest(BaseModel):
    job_id: UUID
    files: list[LocalFileInput]
