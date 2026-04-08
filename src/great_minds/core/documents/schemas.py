"""Document domain schemas."""

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict


DOC_KIND_RAW = "raw"
DOC_KIND_WIKI = "wiki"


class DocumentCreate(BaseModel):
    """Input for creating/upserting a document.

    Field names match frontmatter keys so callers can do:
        DocumentCreate.model_validate({**fm, "file_path": p, "content": c})
    """

    model_config = ConfigDict(extra="ignore")

    file_path: str
    content: str
    doc_kind: str = DOC_KIND_RAW

    title: str = ""
    author: str | None = None
    date: str | int | None = None
    source: str | None = None
    compiled: bool = False
    genre: str | None = None
    tradition: str | None = None
    interlocutors: list[str] = []
    concepts: list[str] = []
    tags: list[str] = []


class Document(BaseModel):
    """Full document domain model. Returned by queries."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    brain_id: uuid.UUID
    file_path: str
    title: str
    author: str | None
    date: str | None
    source: str | None
    genre: str | None
    tradition: str | None
    compiled: bool
    doc_kind: str
    tags: list[str] = []
    concepts: list[str] = []
    interlocutors: list[str] = []
    created_at: datetime | None = None
    updated_at: datetime | None = None
