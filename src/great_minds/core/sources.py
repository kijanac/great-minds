"""Source document metadata shared by ingest entrypoints."""

from pydantic import BaseModel, Field


class SourceMetadata(BaseModel):
    content_type: str = "texts"
    source_type: str = "document"
    author: str | None = None
    published_date: str | None = Field(default=None, serialization_alias="date")
    origin: str | None = None
    title: str | None = None
    url: str | None = None
