"""Ingest request/response schemas."""

from pydantic import BaseModel

from great_minds.core.ingest_service import UserSuggestionIntent


class IngestRequest(BaseModel):
    content: str
    content_type: str = "texts"
    title: str | None = None
    author: str | None = None
    published_date: str | None = None
    origin: str | None = None
    url: str | None = None
    source_type: str = "document"
    dest: str


class IngestUrlRequest(BaseModel):
    url: str
    content_type: str = "texts"
    source_type: str = "document"


class UserSuggestionRequest(BaseModel):
    body: str
    intent: UserSuggestionIntent
    anchored_to: str = ""
    anchored_section: str = ""


class IngestResponse(BaseModel):
    file_path: str
    title: str
