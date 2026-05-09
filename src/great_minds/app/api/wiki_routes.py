"""Wiki and document routes."""

from pathlib import PurePosixPath
from uuid import UUID

from fastapi import APIRouter, HTTPException

from great_minds.app.api.dependencies import (
    SourceDocumentServiceDep,
    VaultStorageDep,
    WikiArticleServiceDep,
    PageParamsQuery,
)
from great_minds.app.api.schemas import wiki as schemas
from great_minds.core.documents import SourceDocumentFacets, WikiArticleOverview
from great_minds.core.markdown import parse_frontmatter
from great_minds.core.pagination import FacetedPage, Page
from great_minds.core.paths import wiki_path

router = APIRouter(tags=["wiki"])


@router.get("/wiki")
async def list_articles(
    vault_id: UUID,
    pagination: PageParamsQuery,
    wiki_service: WikiArticleServiceDep,
) -> Page[WikiArticleOverview]:
    return await wiki_service.list_articles(vault_id, pagination=pagination)


@router.get("/wiki/recent")
async def recent_articles(
    vault_id: UUID,
    pagination: PageParamsQuery,
    wiki_service: WikiArticleServiceDep,
) -> Page[WikiArticleOverview]:
    return await wiki_service.list_articles(
        vault_id, pagination=pagination, recent=True
    )


@router.get("/raw/sources")
async def list_raw_sources(
    vault_id: UUID,
    pagination: PageParamsQuery,
    source_service: SourceDocumentServiceDep,
    content_type: str | None = None,
    search: str | None = None,
    compiled: bool | None = None,
) -> FacetedPage[schemas.SourceDocumentSummary, SourceDocumentFacets]:
    result = await source_service.list_sources(
        vault_id,
        content_type=content_type,
        search=search,
        compiled=compiled,
        pagination=pagination,
    )
    return FacetedPage(
        items=[schemas.SourceDocumentSummary.model_validate(d) for d in result.items],
        pagination=result.pagination,
        facets=result.facets,
    )


@router.get("/wiki/{slug}")
async def read_article(
    vault_id: UUID,
    slug: str,
    storage: VaultStorageDep,
) -> schemas.ArticleResponse:
    content = await storage.read(wiki_path(slug), strict=False)
    if content is not None:
        return schemas.ArticleResponse(slug=slug, content=content)
    raise HTTPException(status_code=404, detail=f"Article not found: {slug}")


@router.get("/doc/{path:path}")
async def read_document(
    vault_id: UUID,
    path: str,
    storage: VaultStorageDep,
    source_service: SourceDocumentServiceDep,
    wiki_service: WikiArticleServiceDep,
) -> schemas.DocResponse:
    try:
        path = _safe_document_read_path(path)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Invalid document path: {path}")

    content = await storage.read(path, strict=False)
    if content is None:
        raise HTTPException(status_code=404, detail=f"Document not found: {path}")
    _, body = parse_frontmatter(content)

    # Callers know: wiki/ paths → wiki_articles table, raw/ paths → source_documents.
    if path.startswith("wiki/"):
        article = await wiki_service.get_by_path(vault_id, path)
        if article is not None:
            return schemas.DocResponse(article=article, body=body)
    else:
        source = await source_service.get_by_path(vault_id, path)
        if source is not None:
            return schemas.DocResponse(article=source, body=body)

    raise HTTPException(
        status_code=500,
        detail=f"Document on disk lacks a registry row: {path}",
    )


def _safe_document_read_path(path: str) -> str:
    if "\\" in path:
        raise ValueError(f"Invalid document path: {path}")

    rel = PurePosixPath(path)
    if not rel.parts or rel.is_absolute() or ".." in rel.parts or rel.suffix != ".md":
        raise ValueError(f"Invalid document path: {path}")

    if rel.parts[0] == "wiki" and len(rel.parts) >= 2:
        return str(rel)
    if rel.parts[0] == "raw" and len(rel.parts) >= 3:
        return str(rel)

    raise ValueError(f"Invalid document path: {path}")
