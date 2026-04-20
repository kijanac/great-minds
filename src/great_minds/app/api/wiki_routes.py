"""Wiki and document routes."""

from pathlib import PurePosixPath
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.app.api.dependencies import (
    get_brain_storage,
    get_document_service,
    require_brain_member,
)
from great_minds.app.api.schemas import wiki as schemas
from great_minds.core import brain as brain_ops
from great_minds.core.brain_utils import parse_frontmatter
from great_minds.core.db import get_session
from great_minds.core.documents.schemas import DocKind
from great_minds.core.documents.service import DocumentService
from great_minds.core.storage import Storage
from great_minds.core.subjects.archive import archive_path
from great_minds.core.subjects.models import ConceptORM
from great_minds.core.subjects.schemas import ArticleStatus

router = APIRouter(tags=["wiki"])


async def _resolve_archive(
    session: AsyncSession,
    brain_id: UUID,
    *,
    slug: str | None = None,
    concept_id: UUID | None = None,
) -> schemas.ArticleResponse | None:
    """Look up an archived article by either slug or concept_id.

    Returns None when the concept is not archived or the archive file
    is missing on disk.
    """
    stmt = select(ConceptORM.concept_id, ConceptORM.slug).where(
        ConceptORM.brain_id == brain_id,
        ConceptORM.article_status == ArticleStatus.ARCHIVED.value,
    )
    if slug is not None:
        stmt = stmt.where(ConceptORM.slug == slug)
    if concept_id is not None:
        stmt = stmt.where(ConceptORM.concept_id == concept_id)
    row = (await session.execute(stmt)).one_or_none()
    if row is None:
        return None

    archive_file = archive_path(brain_id, row.concept_id, row.slug)
    if not archive_file.exists():
        return None

    content = archive_file.read_text(encoding="utf-8")
    fm, _ = parse_frontmatter(content)
    successor = fm.get("superseded_by") or None
    if isinstance(successor, str) and not successor.strip():
        successor = None
    return schemas.ArticleResponse(
        slug=row.slug,
        content=content,
        archived=True,
        superseded_by=successor,
    )


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


@router.get("/wiki/archive/{concept_id}")
async def read_archived_article(
    brain_id: UUID,
    concept_id: UUID,
    session: AsyncSession = Depends(get_session),
    _auth: None = Depends(require_brain_member),
) -> schemas.ArticleResponse:
    """Serve an archived article by its concept_id."""
    archived = await _resolve_archive(session, brain_id, concept_id=concept_id)
    if archived is None:
        raise HTTPException(
            status_code=404, detail=f"Archived concept not found: {concept_id}"
        )
    return archived


@router.get("/wiki/{slug}")
async def read_article(
    brain_id: UUID,
    slug: str,
    storage: Storage = Depends(get_brain_storage),
    session: AsyncSession = Depends(get_session),
) -> schemas.ArticleResponse:
    content = brain_ops.read_article(storage, slug)
    if content is not None:
        return schemas.ArticleResponse(slug=slug, content=content)

    archived = await _resolve_archive(session, brain_id, slug=slug)
    if archived is not None:
        return archived

    raise HTTPException(status_code=404, detail=f"Article not found: {slug}")


@router.get("/doc/{path:path}")
async def read_document(
    brain_id: UUID,
    path: str,
    storage: Storage = Depends(get_brain_storage),
    session: AsyncSession = Depends(get_session),
) -> schemas.DocResponse:
    try:
        path = _safe_document_read_path(path)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Invalid document path: {path}")

    content = storage.read(path, strict=False)
    if content is not None:
        return schemas.DocResponse(path=path, content=content)

    # Session links to a retired slug should resolve against the archive, not 404.
    rel = PurePosixPath(path)
    if rel.parts[0] == "wiki" and len(rel.parts) == 2:
        slug = rel.parts[1].removesuffix(".md")
        archived = await _resolve_archive(session, brain_id, slug=slug)
        if archived is not None:
            return schemas.DocResponse(
                path=path,
                content=archived.content,
                archived=True,
                superseded_by=archived.superseded_by,
            )

    raise HTTPException(status_code=404, detail=f"Document not found: {path}")


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
