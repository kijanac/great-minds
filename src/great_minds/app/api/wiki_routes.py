"""Wiki and document routes."""

from pathlib import PurePosixPath
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException

from great_minds.app.api.dependencies import (
    get_brain_storage,
    get_document_service,
)
from great_minds.app.api.schemas import wiki as schemas
from great_minds.core import brain as brain_ops
from great_minds.core.documents.service import DocumentService
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
    docs = await doc_service.query_documents([brain_id], doc_kind="wiki", limit=limit)
    return [
        schemas.RecentArticleItem(
            title=d.title or d.file_path,
            file_path=d.file_path,
            doc_kind=d.doc_kind,
            updated_at=d.updated_at.isoformat() if d.updated_at else "",
        )
        for d in docs
    ]


@router.get("/wiki/{slug}")
async def read_article(
    slug: str,
    storage: Storage = Depends(get_brain_storage),
) -> schemas.ArticleResponse:
    content = brain_ops.read_article(storage, slug)
    if content is None:
        raise HTTPException(status_code=404, detail=f"Article not found: {slug}")
    return schemas.ArticleResponse(slug=slug, content=content)


@router.get("/doc/{path:path}")
async def read_document(
    path: str,
    storage: Storage = Depends(get_brain_storage),
) -> schemas.DocResponse:
    try:
        path = _safe_document_read_path(path)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Invalid document path: {path}")

    content = storage.read(path, strict=False)
    if content is None:
        raise HTTPException(status_code=404, detail=f"Document not found: {path}")
    return schemas.DocResponse(path=path, content=content)


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
