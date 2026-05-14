"""Wiki and document request/response schemas."""

from datetime import datetime
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field

from great_minds.core.documents.schemas import (
    SourceDocument,
    WikiArticle,
)


class ArticleResponse(BaseModel):
    slug: str
    content: str
    archived: bool = False
    superseded_by: str | None = None


class SourceDocumentSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    file_path: str
    source_type: str
    title: str | None = None
    author: str | None = None
    published_date: str | None = None
    url: str | None = None
    origin: str | None = None
    genre: str | None = None
    precis: str | None = None
    tags: list[str] = Field(default_factory=list)
    derived_extras: dict = Field(default_factory=dict)
    updated_at: datetime | None


class DocResponse(BaseModel):
    """Full read-view for a single document.

    ``article`` is a tagged union: callers discriminate via
    ``article.kind`` (``"source"`` or ``"wiki"``). Body comes from
    storage with the YAML frontmatter stripped.
    """

    article: Annotated[SourceDocument | WikiArticle, Field(discriminator="kind")]
    body: str
    archived: bool = False
    superseded_by: str | None = None
