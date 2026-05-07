"""Ingest request/response schemas."""

from uuid import UUID

from pydantic import BaseModel, Field

from great_minds.core.documents.schemas import SourceMetadata
from great_minds.core.ingest_schemas import StagedFileInput, StagedFileSignedUpload
from great_minds.core.ingest_service import UserSuggestionIntent


class RawSource(BaseModel):
    content: str
    dest: str
    metadata: SourceMetadata = Field(default_factory=SourceMetadata)


class URLSource(BaseModel):
    job_id: UUID
    url: str
    metadata: SourceMetadata = Field(default_factory=SourceMetadata)


class UserSuggestion(BaseModel):
    body: str
    intent: UserSuggestionIntent
    anchored_to: str = ""
    anchored_section: str = ""


class IngestResult(BaseModel):
    file_path: str
    title: str


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
    content_type: str = "texts"
    source_type: str = "document"
