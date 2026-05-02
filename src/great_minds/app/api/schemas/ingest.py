"""Ingest request/response schemas."""

from pydantic import BaseModel, Field

from great_minds.core.documents.schemas import SourceMetadata
from great_minds.core.ingest_service import UserSuggestionIntent


class RawSource(BaseModel):
    content: str
    dest: str
    metadata: SourceMetadata = Field(default_factory=SourceMetadata)


class URLSource(BaseModel):
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
# Bulk direct-to-R2 upload flow
# ---------------------------------------------------------------------------


class BulkSignFile(BaseModel):
    """One entry in the client's upload manifest. ``hash`` is hex-encoded
    SHA-256 of the file bytes — also the staging key suffix."""

    name: str
    size: int
    hash: str
    mimetype: str = ""


class BulkSignRequest(BaseModel):
    files: list[BulkSignFile]


class BulkSignedUrl(BaseModel):
    hash: str
    url: str


class BulkSignResponse(BaseModel):
    files: list[BulkSignedUrl]


class BulkProcessFile(BaseModel):
    hash: str
    name: str
    mimetype: str = ""


class BulkProcessRequest(BaseModel):
    files: list[BulkProcessFile]
    content_type: str = "texts"
    source_type: str = "document"


class BulkProcessResponse(BaseModel):
    task_id: str
