"""Document domain schemas."""

import uuid
from datetime import datetime
from enum import StrEnum

from pydantic import BaseModel, ConfigDict

from great_minds.core.ingester import UNIVERSAL_ALL


class DocKind(StrEnum):
    RAW = "raw"
    WIKI = "wiki"


_UNIVERSAL_KEYS = frozenset(UNIVERSAL_ALL) | {"url"}


class DocumentCreate(BaseModel):
    """Input for creating/upserting a document.

    Universal frontmatter fields (title, author, origin, date, genre, tags)
    are explicit. Config-driven fields live in extra_metadata.
    """

    model_config = ConfigDict(extra="ignore")

    # Structural
    file_path: str
    content: str
    doc_kind: str = DocKind.RAW
    # None for rendered wiki articles; populated (texts/news/ideas/...)
    # for raw docs per brain config.
    source_type: str | None = None
    url: str | None = None
    compiled: bool = False

    # Universal frontmatter
    title: str = ""
    author: str | None = None
    origin: str | None = None
    published_date: str | None = None
    genre: str | None = None
    tags: list[str] = []

    # Precis: 2-3 sentence summary. Raw docs get this from extract;
    # rendered wiki articles get it from the topic's description.
    precis: str | None = None

    # Config-driven metadata (tradition, interlocutors, etc.)
    extra_metadata: dict = {}

    @staticmethod
    def from_frontmatter(
        fm: dict,
        file_path: str,
        content: str,
        doc_kind: str = DocKind.RAW,
    ) -> "DocumentCreate":
        """Build a DocumentCreate from parsed frontmatter.

        Splits universal fields into explicit params and everything else
        into extra_metadata.
        """
        extra = {k: v for k, v in fm.items() if k not in _UNIVERSAL_KEYS}
        return DocumentCreate(
            file_path=file_path,
            content=content,
            doc_kind=doc_kind,
            source_type=fm["source_type"],
            url=fm.get("url"),
            compiled=fm.get("compiled", False),
            title=fm.get("title", ""),
            author=fm.get("author"),
            origin=fm.get("origin"),
            published_date=str(fm["date"]) if "date" in fm else None,
            genre=fm.get("genre"),
            tags=fm.get("tags", []),
            extra_metadata=extra,
        )


class Document(BaseModel):
    """Full document domain model. Returned by queries."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    brain_id: uuid.UUID
    file_path: str
    title: str
    author: str | None
    published_date: str | None
    url: str | None
    origin: str | None
    genre: str | None
    compiled: bool
    doc_kind: str
    # NULL for rendered wiki rows; populated for raw docs.
    source_type: str | None = None
    tags: list[str] = []
    extra_metadata: dict = {}
    created_at: datetime | None = None
    updated_at: datetime | None = None
