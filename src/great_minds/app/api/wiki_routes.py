"""Wiki and document routes."""

from pathlib import PurePosixPath
from uuid import UUID

from fastapi import APIRouter, HTTPException

from great_minds.app.api.dependencies import (
    SearchServiceDep,
    SourceDocumentServiceDep,
    TopicServiceDep,
    VaultStorageDep,
    WikiArticleServiceDep,
    PageParamsQuery,
)
from great_minds.app.api.schemas import wiki as schemas
from great_minds.core.documents import (
    LinkedArticles,
    SourceDocumentFacets,
    WikiArticleOverview,
    WikiArticleService,
)
from great_minds.core.markdown import parse_frontmatter
from great_minds.core.search import Chunk
from great_minds.core.pagination import FacetedPage, Page
from great_minds.core.paths import wiki_path, wiki_slug
from great_minds.core.storage import Storage
from great_minds.core.topics.schemas import ArticleStatus
from great_minds.core.topics.service import TopicService

router = APIRouter(tags=["wiki"])


@router.get("/wiki")
async def list_articles(
    vault_id: UUID,
    pagination: PageParamsQuery,
    wiki_service: WikiArticleServiceDep,
    run: UUID | None = None,
) -> Page[WikiArticleOverview]:
    # ``run`` filters to articles produced by that pipeline run — used by the
    # compile completion card to show "what this compile built".
    return await wiki_service.list_articles(vault_id, pagination=pagination, run_id=run)


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
    source_type: str | None = None,
    search: str | None = None,
) -> FacetedPage[schemas.SourceDocumentSummary, SourceDocumentFacets]:
    result = await source_service.list_sources(
        vault_id,
        source_type=source_type,
        search=search,
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


_MAX_CHUNK_SPAN = 100  # safety cap on a single chunk-window read


@router.get("/chunks")
async def read_chunks(
    vault_id: UUID,
    path: str,
    start: int,
    end: int,
    search: SearchServiceDep,
) -> list[Chunk]:
    """Body chunks of ``path`` in ``[start, end]`` — the passages that
    entered the query agent's context, fetched lazily for the trace panel."""
    end = min(end, start + _MAX_CHUNK_SPAN - 1)
    return await search.fetch_chunk_range([vault_id], path, start, end)


@router.get("/links")
async def read_links(
    vault_id: UUID,
    path: str,
    wiki_service: WikiArticleServiceDep,
) -> LinkedArticles:
    """Outgoing/incoming links for a wiki article — what a linked_articles
    call surfaced, fetched lazily for the trace panel."""
    linked = await wiki_service.linked_articles(vault_id, path)
    if linked is None:
        raise HTTPException(status_code=404, detail=f"Not a wiki article: {path}")
    return linked


@router.get("/doc/{path:path}")
async def read_document(
    vault_id: UUID,
    path: str,
    storage: VaultStorageDep,
    source_service: SourceDocumentServiceDep,
    wiki_service: WikiArticleServiceDep,
    topic_service: TopicServiceDep,
) -> schemas.DocResponse:
    try:
        path = _safe_document_read_path(path)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Invalid document path: {path}")

    content = await storage.read(path, strict=False)
    if content is None:
        # A link minted before a recompile may point at wiki/<slug>.md for
        # a topic since archived (file moved under archive/). Resolve it to
        # the archived artifact + successor instead of a dead 404.
        if path.startswith("wiki/"):
            archived = await _read_archived_wiki(
                vault_id, path, storage, wiki_service, topic_service
            )
            if archived is not None:
                return archived
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


async def _read_archived_wiki(
    vault_id: UUID,
    path: str,
    storage: Storage,
    wiki_service: WikiArticleService,
    topic_service: TopicService,
) -> schemas.DocResponse | None:
    """Resolve an archived article whose live wiki/<slug>.md is gone.

    Returns the archived body (read from its archive/ home) plus the
    successor's slug, so the reader shows an "archived — see successor"
    banner rather than a dead link. ``None`` if the slug isn't an
    archived topic, so the caller falls through to a normal 404.
    """
    slug = wiki_slug(path.rsplit("/", 1)[-1])
    topic = await topic_service.get_by_slug(vault_id, slug)
    if topic is None or topic.article_status != ArticleStatus.ARCHIVED:
        return None
    article = await wiki_service.get_by_topic(vault_id, topic.topic_id)
    if article is None:
        return None
    content = await storage.read(article.file_path, strict=False)
    if content is None:
        return None
    _, body = parse_frontmatter(content)
    successor_slug: str | None = None
    if topic.superseded_by is not None:
        successor = await topic_service.get_by_id(topic.superseded_by)
        successor_slug = successor.slug if successor is not None else None
    return schemas.DocResponse(
        article=article,
        body=body,
        archived=True,
        superseded_by=successor_slug,
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
