"""Document domain schemas."""

import uuid
from datetime import datetime
from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field, computed_field

from great_minds.core.documents.builder import UNIVERSAL_ALL
from great_minds.core.pagination import FacetCount
from great_minds.core.paths import wiki_slug


class DocKind(StrEnum):
    RAW = "raw"
    WIKI = "wiki"


class SourceMetadata(BaseModel):
    """Caller-supplied metadata accompanying an ingest request.

    Universal frontmatter fields the API and CLI hand to ``IngestService``
    before a document is constructed. Distinct from ``DocumentMetadata``
    (which is the parsed view of an already-indexed document's
    frontmatter): this model is the request-side input.
    """

    content_type: str = "texts"
    source_type: str = "document"
    author: str | None = None
    published_date: str | None = Field(default=None, serialization_alias="date")
    origin: str | None = None
    title: str | None = None
    url: str | None = None


_UNIVERSAL_KEYS = frozenset(UNIVERSAL_ALL) | {"url"}


class DocumentMetadata(BaseModel):
    """Source and enrichment metadata for an indexed document."""

    title: str = ""
    author: str | None = None
    published_date: str | None = None
    url: str | None = None
    origin: str | None = None
    genre: str | None = None
    precis: str | None = None
    # NULL for rendered wiki rows; populated for raw docs.
    source_type: str | None = None
    tags: list[str] = Field(default_factory=list)
    extra_metadata: dict = Field(default_factory=dict)


class DocumentCreate(BaseModel):
    """Input for creating/upserting a document.

    Universal frontmatter fields (title, author, origin, date, genre, tags)
    are explicit. Config-driven fields live in extra_metadata. ``topic_id``
    is set for wiki rows by render and NULL for raw rows.
    """

    model_config = ConfigDict(extra="ignore")

    file_path: str
    content: str
    doc_kind: str = DocKind.RAW
    compiled: bool = False
    topic_id: uuid.UUID | None = None
    metadata: DocumentMetadata = Field(default_factory=DocumentMetadata)

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
            compiled=fm.get("compiled", False),
            metadata=DocumentMetadata(
                source_type=fm.get("source_type"),
                url=fm.get("url"),
                title=fm.get("title", ""),
                author=fm.get("author"),
                origin=fm.get("origin"),
                published_date=str(fm["date"]) if "date" in fm else None,
                genre=fm.get("genre"),
                tags=fm.get("tags", []),
                extra_metadata=extra,
            ),
        )


class Document(BaseModel):
    """Indexed document record. Body content lives in storage."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    vault_id: uuid.UUID
    file_path: str
    body_hash: str
    compiled: bool
    doc_kind: str
    topic_id: uuid.UUID | None = None
    metadata: DocumentMetadata
    created_at: datetime | None = None
    updated_at: datetime | None = None


class WikiArticleSummary(BaseModel):
    """Wiki article browse-row shape.

    ``file_path`` is the canonical identifier (matches the documents
    table). ``slug`` is the URL component consumers use, derived from
    file_path via the wiki path convention. ``precis`` and
    ``updated_at`` are optional — populated for the browse page, left
    None for surfaces (like lint orphans) that only need title.

    ``from_attributes=True`` lets the repository pass SQLAlchemy ``Row``
    objects straight to ``model_validate`` (rows have labeled-column
    attribute access), avoiding manual unpacking.
    """

    model_config = ConfigDict(from_attributes=True)

    file_path: str
    title: str
    precis: str | None = None
    updated_at: datetime | None = None

    @computed_field  # type: ignore[prop-decorator]
    @property
    def slug(self) -> str:
        return wiki_slug(self.file_path)


class Backlink(BaseModel):
    source_document_id: uuid.UUID
    target_document_id: uuid.UUID


class SourceDocumentFacets(BaseModel):
    content_types: list[FacetCount] = Field(default_factory=list)
