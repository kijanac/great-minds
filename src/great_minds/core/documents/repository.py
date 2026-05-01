"""Document index repository: upsert and structured document queries."""

import hashlib
from collections import defaultdict
from uuid import UUID

from sqlalchemy import Select, delete, distinct, func, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.core.documents.models import (
    BacklinkORM,
    DocumentORM,
    DocumentTag,
)
from great_minds.core.documents.schemas import (
    Backlink,
    DocKind,
    Document,
    DocumentCreate,
    DocumentMetadata,
    WikiArticleSummary,
)
from great_minds.core.ideas.schemas import SourceCard
from great_minds.core.markdown import parse_frontmatter
from great_minds.core.pagination import FacetCount
from great_minds.core.paths import WIKI_PREFIX, raw_prefix, wiki_slug


class DocumentRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def upsert(self, brain_id: UUID, doc: DocumentCreate) -> UUID:
        """Upsert a document row and sync the tags junction table."""
        file_hash = hashlib.sha256(doc.content.encode()).hexdigest()
        _, body = parse_frontmatter(doc.content)
        body_hash = hashlib.sha256(body.encode()).hexdigest()

        columns = {
            "file_hash": file_hash,
            "body_hash": body_hash,
            "title": doc.metadata.title,
            "author": doc.metadata.author,
            "url": doc.metadata.url,
            "origin": doc.metadata.origin,
            "published_date": doc.metadata.published_date,
            "genre": doc.metadata.genre,
            "compiled": doc.compiled,
            "doc_kind": doc.doc_kind,
            "source_type": doc.metadata.source_type,
            "precis": doc.metadata.precis,
        }

        stmt = (
            insert(DocumentORM)
            .values(
                brain_id=brain_id,
                file_path=doc.file_path,
                extra_metadata=doc.metadata.extra_metadata,
                **columns,
            )
            .on_conflict_do_update(
                constraint="documents_brain_id_file_path_key",
                set_={
                    **columns,
                    "metadata": doc.metadata.extra_metadata,
                    "updated_at": func.now(),
                },
            )
        )
        result = await self.session.execute(stmt.returning(DocumentORM.id))
        doc_id = result.scalar_one()

        await self._sync_tags(doc_id, doc.metadata.tags)

        return doc_id

    async def batch_upsert(
        self, brain_id: UUID, docs: list[DocumentCreate]
    ) -> list[UUID]:
        """Upsert documents in a single statement. Returns IDs in input order.

        Tag sync still happens per-doc — a real bulk tag sync (delete-by-doc-id-set
        + bulk insert junction rows) is a follow-up.
        """
        if not docs:
            return []

        rows = []
        for doc in docs:
            file_hash = hashlib.sha256(doc.content.encode()).hexdigest()
            _, body = parse_frontmatter(doc.content)
            body_hash = hashlib.sha256(body.encode()).hexdigest()
            rows.append(
                {
                    "brain_id": brain_id,
                    "file_path": doc.file_path,
                    "file_hash": file_hash,
                    "body_hash": body_hash,
                    "title": doc.metadata.title,
                    "author": doc.metadata.author,
                    "url": doc.metadata.url,
                    "origin": doc.metadata.origin,
                    "published_date": doc.metadata.published_date,
                    "genre": doc.metadata.genre,
                    "compiled": doc.compiled,
                    "doc_kind": doc.doc_kind,
                    "source_type": doc.metadata.source_type,
                    "precis": doc.metadata.precis,
                    "extra_metadata": doc.metadata.extra_metadata,
                }
            )

        stmt = insert(DocumentORM).values(rows)
        stmt = stmt.on_conflict_do_update(
            constraint="documents_brain_id_file_path_key",
            set_={
                "file_hash": stmt.excluded.file_hash,
                "body_hash": stmt.excluded.body_hash,
                "title": stmt.excluded.title,
                "author": stmt.excluded.author,
                "url": stmt.excluded.url,
                "origin": stmt.excluded.origin,
                "published_date": stmt.excluded.published_date,
                "genre": stmt.excluded.genre,
                "compiled": stmt.excluded.compiled,
                "doc_kind": stmt.excluded.doc_kind,
                "source_type": stmt.excluded.source_type,
                "precis": stmt.excluded.precis,
                "metadata": stmt.excluded["metadata"],
                "updated_at": func.now(),
            },
        )
        result = await self.session.execute(
            stmt.returning(DocumentORM.id, DocumentORM.file_path)
        )
        # RETURNING order isn't guaranteed by Postgres, so map back via file_path.
        id_by_path = {row.file_path: row.id for row in result}

        doc_ids: list[UUID] = []
        for doc in docs:
            doc_id = id_by_path[doc.file_path]
            await self._sync_tags(doc_id, doc.metadata.tags)
            doc_ids.append(doc_id)
        return doc_ids

    async def get_file_hashes(self, brain_id: UUID) -> dict[str, str]:
        """Return {file_path: file_hash} for all documents in a brain.

        Used for skip detection during bulk ingest.
        """
        result = await self.session.execute(
            select(DocumentORM.file_path, DocumentORM.file_hash).where(
                DocumentORM.brain_id == brain_id
            )
        )
        return {row.file_path: row.file_hash for row in result}

    async def get_title_by_path(
        self, brain_id: UUID, file_path: str
    ) -> str | None:
        """Return just the LLM-generated title for a path, or None if the
        document isn't indexed or hasn't been extracted yet. Single
        indexed query — no tag JOIN, no full row hydration."""
        result = await self.session.execute(
            select(DocumentORM.title).where(
                DocumentORM.brain_id == brain_id,
                DocumentORM.file_path == file_path,
            )
        )
        title = result.scalar_one_or_none()
        return title or None

    async def get_by_path(
        self, brain_id: UUID, file_path: str
    ) -> Document | None:
        """Return the single document at ``file_path`` for this brain, or None."""
        result = await self.session.execute(
            select(DocumentORM).where(
                DocumentORM.brain_id == brain_id,
                DocumentORM.file_path == file_path,
            )
        )
        row = result.scalar_one_or_none()
        if row is None:
            return None

        tag_rows = await self.session.execute(
            select(DocumentTag.tag).where(DocumentTag.document_id == row.id)
        )
        tags = list(tag_rows.scalars().all())
        return _document_from_orm(row, tags=tags)

    async def list_by_kind(
        self, brain_id: UUID, kind: DocKind
    ) -> list[Document]:
        """Return all documents of a given kind, ordered by file_path.

        Used by extract (iterate raw docs) and render (resolve footnote
        source metadata) — both want a deterministic ordering.
        """
        rows = await self.session.execute(
            select(DocumentORM)
            .where(
                DocumentORM.brain_id == brain_id,
                DocumentORM.doc_kind == kind.value,
            )
            .order_by(DocumentORM.file_path)
        )
        return [_document_from_orm(r) for r in rows.scalars().all()]

    async def update_metadata_from_cards(
        self, brain_id: UUID, cards: list[SourceCard]
    ) -> None:
        """Push LLM-produced title, precis, doc_metadata back to DB rows.

        extra_metadata is replaced wholesale — the LLM output is the
        authoritative source for per-doc enriched fields.
        """
        for card in cards:
            await self.session.execute(
                update(DocumentORM)
                .where(
                    DocumentORM.brain_id == brain_id,
                    DocumentORM.id == card.document_id,
                )
                .values(
                    title=card.title,
                    precis=card.precis,
                    extra_metadata=card.doc_metadata.model_dump(mode="json"),
                )
            )

    async def count_by_kind(self, brain_id: UUID, kind: DocKind) -> int:
        return (
            await self.session.scalar(
                select(func.count())
                .select_from(DocumentORM)
                .where(
                    DocumentORM.brain_id == brain_id,
                    DocumentORM.doc_kind == kind.value,
                )
            )
        ) or 0

    async def list_wiki_summaries(
        self, brain_id: UUID, *, limit: int = 50, offset: int = 0
    ) -> list[WikiArticleSummary]:
        rows = (
            await self.session.execute(
                select(
                    DocumentORM.file_path,
                    DocumentORM.title,
                    DocumentORM.precis,
                    DocumentORM.updated_at,
                )
                .where(
                    DocumentORM.brain_id == brain_id,
                    DocumentORM.doc_kind == DocKind.WIKI,
                    DocumentORM.file_path.not_like(f"{WIKI_PREFIX}_%"),
                )
                .order_by(func.lower(DocumentORM.title))
                .offset(offset)
                .limit(limit)
            )
        ).all()
        return [
            WikiArticleSummary(
                slug=wiki_slug(file_path),
                title=title,
                precis=precis,
                updated_at=updated_at,
            )
            for file_path, title, precis, updated_at in rows
        ]

    async def count_wiki_article_paths(self, brain_id: UUID) -> int:
        return (
            await self.session.scalar(
                select(func.count()).where(
                    DocumentORM.brain_id == brain_id,
                    DocumentORM.doc_kind == DocKind.WIKI,
                    DocumentORM.file_path.not_like(f"{WIKI_PREFIX}_%"),
                )
            )
        ) or 0

    async def list_orphan_wiki_documents(
        self, brain_id: UUID
    ) -> list[WikiArticleSummary]:
        """Return rendered wiki documents with zero incoming backlinks."""
        rows = (
            await self.session.execute(
                select(DocumentORM.file_path, DocumentORM.title)
                .outerjoin(
                    BacklinkORM,
                    BacklinkORM.target_document_id == DocumentORM.id,
                )
                .where(
                    DocumentORM.brain_id == brain_id,
                    DocumentORM.doc_kind == DocKind.WIKI.value,
                    DocumentORM.file_path.not_like(f"{WIKI_PREFIX}_%"),
                )
                .group_by(DocumentORM.id, DocumentORM.file_path, DocumentORM.title)
                .having(func.count(BacklinkORM.source_document_id) == 0)
                .order_by(func.lower(DocumentORM.title))
            )
        ).all()
        return [
            WikiArticleSummary(slug=wiki_slug(file_path), title=title)
            for file_path, title in rows
        ]

    async def update_wiki_backlinks(
        self,
        source_document_ids: list[UUID],
        backlinks: list[Backlink],
    ) -> None:
        """Update backlink edges emitted by the given source wiki documents."""
        if not source_document_ids:
            return

        await self.session.execute(
            delete(BacklinkORM).where(
                BacklinkORM.source_document_id.in_(source_document_ids)
            )
        )
        if backlinks:
            await self.session.execute(
                insert(BacklinkORM).values(
                    [backlink.model_dump() for backlink in backlinks]
                )
            )

    async def _sync_tags(self, doc_id: UUID, tags: list[str]) -> None:
        """Replace all tag rows for a document with the new set."""
        await self.session.execute(
            delete(DocumentTag).where(DocumentTag.document_id == doc_id)
        )
        rows = [{"document_id": doc_id, "tag": val} for val in tags if val]
        if rows:
            await self.session.execute(insert(DocumentTag).values(rows))

    async def query_documents(
        self,
        brain_ids: list[UUID],
        *,
        tags: list[str] | None = None,
        author: str | None = None,
        genre: str | None = None,
        compiled: bool | None = None,
        doc_kind: DocKind | None = None,
        source_type: str | None = None,
        content_type: str | None = None,
        search: str | None = None,
        date_gte: str | None = None,
        date_lte: str | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> list[Document]:
        """Structured query over the documents table with optional filters."""
        stmt = _document_query(
            brain_ids,
            tags=tags,
            author=author,
            genre=genre,
            compiled=compiled,
            doc_kind=doc_kind,
            source_type=source_type,
            content_type=content_type,
            search=search,
            date_gte=date_gte,
            date_lte=date_lte,
        )
        stmt = stmt.order_by(DocumentORM.updated_at.desc()).offset(offset).limit(limit)

        result = await self.session.execute(stmt)
        docs = result.scalars().all()

        if not docs:
            return []

        doc_ids = [doc.id for doc in docs]

        tag_result = await self.session.execute(
            select(DocumentTag.document_id, DocumentTag.tag).where(
                DocumentTag.document_id.in_(doc_ids)
            )
        )

        tags_by_doc: dict[UUID, list[str]] = defaultdict(list)
        for doc_id, tag in tag_result:
            tags_by_doc[doc_id].append(tag)

        return [
            _document_from_orm(orm, tags=tags_by_doc[orm.id])
            for orm in docs
        ]

    async def count_documents(
        self,
        brain_ids: list[UUID],
        *,
        tags: list[str] | None = None,
        author: str | None = None,
        genre: str | None = None,
        compiled: bool | None = None,
        doc_kind: DocKind | None = None,
        source_type: str | None = None,
        content_type: str | None = None,
        search: str | None = None,
        date_gte: str | None = None,
        date_lte: str | None = None,
    ) -> int:
        """Count documents using the same filters as ``query_documents``."""
        filtered = _document_query(
            brain_ids,
            tags=tags,
            author=author,
            genre=genre,
            compiled=compiled,
            doc_kind=doc_kind,
            source_type=source_type,
            content_type=content_type,
            search=search,
            date_gte=date_gte,
            date_lte=date_lte,
        ).subquery()
        return (
            await self.session.scalar(select(func.count()).select_from(filtered))
        ) or 0

    async def get_content_type_counts(
        self, brain_ids: list[UUID]
    ) -> list[FacetCount]:
        """Return content_type facet counts for raw documents.

        Extracts the content type from file_path: raw/{content_type}/...
        """
        # split_part(file_path, '/', 2) extracts the second path segment
        content_type_col = func.split_part(DocumentORM.file_path, "/", 2).label(
            "content_type"
        )
        result = await self.session.execute(
            select(content_type_col, func.count().label("cnt"))
            .where(
                DocumentORM.brain_id.in_(brain_ids),
                DocumentORM.doc_kind == DocKind.RAW,
            )
            .group_by(content_type_col)
            .order_by(func.count().desc())
        )
        return [FacetCount(value=row.content_type, count=row.cnt) for row in result]

    async def get_distinct_tags(self, brain_ids: list[UUID]) -> list[str]:
        result = await self.session.execute(
            select(distinct(DocumentTag.tag))
            .join(DocumentORM, DocumentORM.id == DocumentTag.document_id)
            .where(DocumentORM.brain_id.in_(brain_ids))
            .order_by(DocumentTag.tag)
        )
        return list(result.scalars().all())


def _document_from_orm(orm: DocumentORM, *, tags: list[str] | None = None) -> Document:
    return Document(
        id=orm.id,
        brain_id=orm.brain_id,
        file_path=orm.file_path,
        body_hash=orm.body_hash,
        compiled=orm.compiled,
        doc_kind=orm.doc_kind,
        metadata=DocumentMetadata(
            title=orm.title,
            author=orm.author,
            published_date=orm.published_date,
            url=orm.url,
            origin=orm.origin,
            genre=orm.genre,
            precis=orm.precis,
            source_type=orm.source_type,
            tags=tags or [],
            extra_metadata=orm.extra_metadata,
        ),
        created_at=orm.created_at,
        updated_at=orm.updated_at,
    )


def _document_query(
    brain_ids: list[UUID],
    *,
    tags: list[str] | None = None,
    author: str | None = None,
    genre: str | None = None,
    compiled: bool | None = None,
    doc_kind: DocKind | None = None,
    source_type: str | None = None,
    content_type: str | None = None,
    search: str | None = None,
    date_gte: str | None = None,
    date_lte: str | None = None,
) -> Select[tuple[DocumentORM]]:
    stmt = select(DocumentORM).where(DocumentORM.brain_id.in_(brain_ids))

    if tags:
        tag_subq = (
            select(DocumentTag.document_id)
            .where(DocumentTag.tag.in_(tags))
            .group_by(DocumentTag.document_id)
            .having(func.count(distinct(DocumentTag.tag)) >= len(tags))
        )
        stmt = stmt.where(DocumentORM.id.in_(tag_subq))

    if author:
        stmt = stmt.where(DocumentORM.author.ilike(f"%{author}%"))
    if genre:
        stmt = stmt.where(DocumentORM.genre == genre)
    if compiled is not None:
        stmt = stmt.where(DocumentORM.compiled == compiled)
    if doc_kind:
        stmt = stmt.where(DocumentORM.doc_kind == doc_kind)
    if source_type:
        stmt = stmt.where(DocumentORM.source_type == source_type)
    if content_type:
        stmt = stmt.where(DocumentORM.file_path.like(f"{raw_prefix(content_type)}/%"))
    if search:
        stmt = stmt.where(
            DocumentORM.title.ilike(f"%{search}%")
            | DocumentORM.author.ilike(f"%{search}%")
        )
    if date_gte:
        stmt = stmt.where(DocumentORM.published_date >= date_gte)
    if date_lte:
        stmt = stmt.where(DocumentORM.published_date <= date_lte)

    return stmt
