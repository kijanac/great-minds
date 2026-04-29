"""Shared pagination and faceting primitives for core query results."""

from typing import Generic, TypeVar

from pydantic import BaseModel, Field

T = TypeVar("T")
F = TypeVar("F")


class PageParams(BaseModel):
    limit: int = Field(default=50, ge=0, le=200)
    offset: int = Field(default=0, ge=0)


class PageInfo(PageParams):
    total: int = Field(ge=0)


class Page(BaseModel, Generic[T]):
    items: list[T]
    pagination: PageInfo


class FacetCount(BaseModel):
    value: str
    count: int


class FacetedPage(Page[T], Generic[T, F]):
    facets: F
