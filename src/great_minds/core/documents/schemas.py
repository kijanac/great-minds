"""Source document and wiki article domain schemas."""

from typing import Literal
from uuid import UUID
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, computed_field

from great_minds.core.documents.builder import UNIVERSAL_ALL
from great_minds.core.ideas.schemas import DocMetadata
from great_minds.core.pagination import FacetCount
from great_minds.core.paths import wiki_slug

# ---------------------------------------------------------------------------
# Ingest-time source metadata (caller-supplied request input)
# ---------------------------------------------------------------------------


class SourceMetadata(BaseModel):
    """Caller-supplied metadata accompanying an ingest request.

    Universal frontmatter fields the API and CLI hand to ``IngestService``
    before a source document is constructed.
    """

    content_type: str = "texts"
    source_type: str = "document"
    author: str | None = None
    published_date: str | None = Field(default=None, serialization_alias="date")
    origin: str | None = None
    title: str | None = None
    url: str | None = None


_UNIVERSAL_KEYS = frozenset(UNIVERSAL_ALL) | {"url"}


# ---------------------------------------------------------------------------
# Shared metadata (parsed frontmatter view)
# ---------------------------------------------------------------------------


class DocumentMetadata(BaseModel):
    """Source and enrichment metadata for an indexed source document."""

    title: str = ""
    author: str | None = None
    published_date: str | None = None
    url: str | None = None
    origin: str | None = None
    genre: str | None = None
    precis: str | None = None
    source_type: str | None = None
    tags: list[str] = Field(default_factory=list)
    doc_metadata: DocMetadata = Field(default_factory=DocMetadata)


# ---------------------------------------------------------------------------
# Create inputs
# ---------------------------------------------------------------------------


class SourceDocCreate(BaseModel):
    """Input for creating / upserting a source document."""

    model_config = ConfigDict(extra="ignore")

    file_path: str
    content: str
    compiled: bool = False
    etag: str | None = None
    metadata: DocumentMetadata = Field(default_factory=DocumentMetadata)

    @staticmethod
    def from_frontmatter(
        fm: dict,
        file_path: str,
        content: str,
    ) -> "SourceDocCreate":
        extra = {k: v for k, v in fm.items() if k not in _UNIVERSAL_KEYS}
        return SourceDocCreate(
            file_path=file_path,
            content=content,
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
                doc_metadata=DocMetadata.model_validate(extra),
            ),
        )


class WikiArticleCreate(BaseModel):
    """Input for creating / upserting a rendered wiki article.

    ``title`` and ``precis`` are snapshots from the topic at render
    time. They live on the article row so reads don't JOIN topics for
    display; drift between snapshot and live topic is a queryable
    staleness signal.
    """

    file_path: str
    content: str
    topic_id: UUID
    title: str
    precis: str


# ---------------------------------------------------------------------------
# Read models
# ---------------------------------------------------------------------------


class SourceDocument(BaseModel):
    """Indexed source document.  Body lives in storage.

    Flat by design: every field maps 1:1 to a column on the
    ``source_documents`` table so reads are a clean
    ``SourceDocument.model_validate(orm)`` with no helper. The nested
    ``DocumentMetadata`` shape is retained for *input* schemas only
    (``SourceDocCreate``) where it mirrors parsed frontmatter.

    ``kind`` is a class-Literal tag used as the discriminator for the
    ``SourceDocument | WikiArticle`` union exposed at the API edge.
    It's not stored — class identity is the source of truth, and the
    default kicks in for ``model_validate(orm)`` calls since the ORM
    has no corresponding column.
    """

    model_config = ConfigDict(from_attributes=True)

    kind: Literal["source"] = "source"
    id: UUID
    vault_id: UUID
    file_path: str
    body_hash: str
    compiled: bool
    etag: str | None = None
    title: str
    author: str | None = None
    published_date: str | None = None
    url: str | None = None
    origin: str | None = None
    genre: str | None = None
    precis: str | None = None
    source_type: str | None = None
    tags: list[str] = Field(default_factory=list)
    doc_metadata: DocMetadata = Field(default_factory=DocMetadata)
    created_at: datetime | None = None
    updated_at: datetime | None = None


class WikiArticle(BaseModel):
    """Rendered wiki article.  Title / precis are snapshots from the
    topic at render time, stored on the article row.

    ``kind`` is a class-Literal tag used as the discriminator for the
    ``SourceDocument | WikiArticle`` union exposed at the API edge.
    See ``SourceDocument`` for the full rationale.
    """

    model_config = ConfigDict(from_attributes=True)

    kind: Literal["wiki"] = "wiki"
    id: UUID
    vault_id: UUID
    topic_id: UUID
    file_path: str
    body_hash: str
    title: str
    precis: str
    created_at: datetime | None = None
    updated_at: datetime | None = None

    @computed_field  # type: ignore[prop-decorator]
    @property
    def slug(self) -> str:
        return wiki_slug(self.file_path)


class WikiArticleOverview(BaseModel):
    """Wiki article list row — title / precis read directly from the
    article row (snapshot at last render)."""

    model_config = ConfigDict(from_attributes=True)

    file_path: str
    title: str
    precis: str
    updated_at: datetime | None = None

    @computed_field  # type: ignore[prop-decorator]
    @property
    def slug(self) -> str:
        return wiki_slug(self.file_path)


# ---------------------------------------------------------------------------
# Backlinks
# ---------------------------------------------------------------------------


class Backlink(BaseModel):
    source_article_id: UUID
    target_article_id: UUID


# ---------------------------------------------------------------------------
# Utility
# ---------------------------------------------------------------------------


class FileHash(BaseModel):
    """(file_path, file_hash) row for staged ingest skip detection."""

    model_config = ConfigDict(from_attributes=True)
    file_path: str
    file_hash: str


class SourceDocumentUpdate(BaseModel):
    """Partial update for source documents."""

    model_config = ConfigDict(from_attributes=True)

    document_id: UUID
    etag: str | None = None
    title: str | None = None
    precis: str | None = None
    doc_metadata: DocMetadata | None = None


class IngestedDocument(BaseModel):
    """Result of a successful source ingest operation."""

    file_path: str
    title: str


class SourceDocumentFacets(BaseModel):
    content_types: list[FacetCount] = Field(default_factory=list)
