"""Wiki and document routes.

Archive lookups are disabled during the seven-phase refactor — the topics
table and the topic-scoped archive flow will restore them. Raw wiki and
raw-doc reads continue to work off the filesystem.
"""

from pathlib import PurePosixPath
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException

from great_minds.app.api.dependencies import (
    get_brain_storage,
    get_document_repository,
    get_document_service,
)
from great_minds.app.api.schemas import wiki as schemas
from great_minds.core import brain as brain_ops
from great_minds.core.documents.repository import DocumentRepository
from great_minds.core.documents.schemas import DocKind
from great_minds.core.documents.service import DocumentService
from great_minds.core.markdown import parse_frontmatter
from great_minds.core.storage import Storage

router = APIRouter(tags=["wiki"])


@router.get("/wiki")
async def list_articles(
    storage: Storage = Depends(get_brain_storage),
) -> list[str]:
    return brain_ops.list_articles(storage)


@router.get("/wiki/recent")
async def recent_articles(
    brain_id: UUID,
    limit: int = 10,
    doc_service: DocumentService = Depends(get_document_service),
    _auth: None = Depends(get_brain_storage),
) -> list[schemas.RecentArticleItem]:
    docs = await doc_service.query_documents(
        [brain_id], doc_kind=DocKind.WIKI, limit=limit
    )
    return [schemas.RecentArticleItem.model_validate(d) for d in docs]


@router.get("/raw/sources")
async def list_raw_sources(
    brain_id: UUID,
    content_type: str | None = None,
    search: str | None = None,
    compiled: bool | None = None,
    limit: int = 50,
    offset: int = 0,
    doc_service: DocumentService = Depends(get_document_service),
    _auth: None = Depends(get_brain_storage),
) -> schemas.RawSourcesResponse:
    docs, content_types = await doc_service.list_raw_sources(
        brain_id,
        content_type=content_type,
        search=search,
        compiled=compiled,
        limit=limit,
        offset=offset,
    )
    return schemas.RawSourcesResponse(
        items=[schemas.RawSourceItem.model_validate(d) for d in docs],
        content_types=[
            schemas.ContentTypeCount(content_type=ct, count=cnt)
            for ct, cnt in content_types
        ],
    )


@router.get("/wiki/{slug}")
async def read_article(
    brain_id: UUID,
    slug: str,
    storage: Storage = Depends(get_brain_storage),
) -> schemas.ArticleResponse:
    content = brain_ops.read_article(storage, slug)
    if content is not None:
        return schemas.ArticleResponse(slug=slug, content=content)
    raise HTTPException(status_code=404, detail=f"Article not found: {slug}")


@router.get("/doc/{path:path}")
async def read_document(
    brain_id: UUID,
    path: str,
    storage: Storage = Depends(get_brain_storage),
    doc_repo: DocumentRepository = Depends(get_document_repository),
) -> schemas.DocResponse:
    try:
        path = _safe_document_read_path(path)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Invalid document path: {path}")

    content = storage.read(path, strict=False)
    if content is None:
        raise HTTPException(status_code=404, detail=f"Document not found: {path}")
    _, body = parse_frontmatter(content)

    document = await doc_repo.get_by_path(brain_id, path)
    if document is None:
        # File exists on disk without a DB row — an ingest invariant
        # violation. Surface loudly; a reconciliation pass would repair.
        raise HTTPException(
            status_code=500,
            detail=f"Document on disk lacks a registry row: {path}",
        )

    return schemas.DocResponse(document=document, body=body)


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
