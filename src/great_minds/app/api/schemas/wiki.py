"""Wiki and document request/response schemas."""

from pydantic import BaseModel


class ArticleResponse(BaseModel):
    slug: str
    content: str


class RecentArticleItem(BaseModel):
    title: str
    file_path: str
    doc_kind: str
    updated_at: str


class DocResponse(BaseModel):
    path: str
    content: str
