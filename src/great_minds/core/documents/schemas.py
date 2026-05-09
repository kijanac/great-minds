"""Source document and wiki article domain schemas."""

from uuid import UUID
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, computed_field

from great_minds.core.documents.builder import UNIVERSAL_ALL
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
    doc_metadata: dict = Field(default_factory=dict)


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
                doc_metadata=extra,
            ),
        )


class WikiArticleCreate(BaseModel):
    """Input for creating / upserting a rendered wiki article."""

    file_path: str
    content: str
    topic_id: UUID
    metadata: DocumentMetadata = Field(default_factory=DocumentMetadata)


# ---------------------------------------------------------------------------
# Read models
# ---------------------------------------------------------------------------


class SourceDocument(BaseModel):
    """Indexed source document.  Body lives in storage."""

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    vault_id: UUID
    file_path: str
    body_hash: str
    compiled: bool
    etag: str | None = None
    metadata: DocumentMetadata
    created_at: datetime | None = None
    updated_at: datetime | None = None


class WikiArticle(BaseModel):
    """Rendered wiki article.  Title / description joined from topics at read time."""

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    vault_id: UUID
    topic_id: UUID
    file_path: str
    body_hash: str
    title: str = ""
    precis: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None

    @computed_field  # type: ignore[prop-decorator]
    @property
    def slug(self) -> str:
        return wiki_slug(self.file_path)


class WikiArticleOverview(BaseModel):
    """Wiki article list row — joins topics for title / precis."""

    model_config = ConfigDict(from_attributes=True)

    file_path: str
    title: str
    precis: str | None = None
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
    doc_metadata: dict | None = None


class IngestedDocument(BaseModel):
    """Result of a successful source ingest operation."""

    file_path: str
    title: str


class SourceDocumentFacets(BaseModel):
    content_types: list[FacetCount] = Field(default_factory=list)
