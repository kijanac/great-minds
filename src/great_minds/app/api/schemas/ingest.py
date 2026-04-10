"""Ingest request/response schemas."""

from pydantic import BaseModel


class IngestRequest(BaseModel):
    content: str
    content_type: str = "texts"
    title: str | None = None
    author: str | None = None
    date: str | int | None = None
    source: str | None = None
    dest: str


class IngestUrlRequest(BaseModel):
    url: str
    content_type: str = "texts"


class IngestResponse(BaseModel):
    file_path: str
    title: str
