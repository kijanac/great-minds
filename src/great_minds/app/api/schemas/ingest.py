"""Ingest request/response schemas."""

from uuid import UUID

from pydantic import BaseModel, Field

from great_minds.core.documents.schemas import SourceMetadata
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


class StagedFileSignFile(BaseModel):
    """One entry in the client's upload manifest. ``hash`` is hex-encoded
    SHA-256 of the file bytes — also the staging key suffix."""

    name: str
    size: int
    hash: str
    mimetype: str = ""


class StagedFileSignRequest(BaseModel):
    files: list[StagedFileSignFile]


class StagedFileSignedUrl(BaseModel):
    hash: str
    url: str


class StagedFileSignResponse(BaseModel):
    files: list[StagedFileSignedUrl]


class StagedFileProcessFile(BaseModel):
    hash: str
    name: str
    mimetype: str = ""


class StagedFileProcessRequest(BaseModel):
    job_id: UUID
    files: list[StagedFileProcessFile]
    content_type: str = "texts"
    source_type: str = "document"
