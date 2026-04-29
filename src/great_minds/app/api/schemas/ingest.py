"""Ingest request/response schemas."""

from pydantic import BaseModel, Field

from great_minds.core.ingest_service import UserSuggestionIntent
from great_minds.core.sources import SourceMetadata


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
