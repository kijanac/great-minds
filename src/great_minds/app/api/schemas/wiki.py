"""Wiki and document request/response schemas."""

from datetime import datetime

from pydantic import BaseModel, ConfigDict

from great_minds.core.documents.schemas import Document, DocumentMetadata


class ArticleResponse(BaseModel):
    slug: str
    content: str
    archived: bool = False
    superseded_by: str | None = None


class RecentArticleItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    file_path: str
    doc_kind: str
    metadata: DocumentMetadata
    updated_at: datetime | None


class SourceDocumentSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    file_path: str
    compiled: bool
    metadata: DocumentMetadata
    updated_at: datetime | None


class DocResponse(BaseModel):
    """Full read-view for a single document.

    Metadata comes from the DB (``Document`` — populated by ingest and
    updated by extract's LLM enrichment). Body comes from storage with
    the YAML frontmatter stripped. Re-parsing frontmatter at read time
    would duplicate work the DB has already done, so we don't.
    """

    document: Document
    body: str
    archived: bool = False
    superseded_by: str | None = None
