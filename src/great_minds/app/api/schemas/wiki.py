"""Wiki and document request/response schemas."""

from datetime import datetime

from pydantic import BaseModel, ConfigDict


class ArticleResponse(BaseModel):
    slug: str
    content: str
    archived: bool = False
    superseded_by: str | None = None


class RecentArticleItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    title: str
    file_path: str
    doc_kind: str
    updated_at: datetime | None


class RawSourceItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    title: str
    file_path: str
    author: str | None
    origin: str | None
    published_date: str | None
    compiled: bool
    source_type: str
    updated_at: datetime | None


class ContentTypeCount(BaseModel):
    content_type: str
    count: int


class RawSourcesResponse(BaseModel):
    items: list[RawSourceItem]
    content_types: list[ContentTypeCount]


class DocResponse(BaseModel):
    path: str
    content: str
    archived: bool = False
    superseded_by: str | None = None
