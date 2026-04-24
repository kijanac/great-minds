"""Document index repository: upsert, query, and backlink operations."""

import hashlib
from collections import defaultdict
from uuid import UUID

from sqlalchemy import delete, distinct, func, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.core.documents.models import (
    DocumentORM,
    DocumentTag,
)
from great_minds.core.documents.schemas import DocKind, Document, DocumentCreate
from great_minds.core.ideas.schemas import SourceCard
from great_minds.core.paths import raw_prefix


class DocumentRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def upsert(self, brain_id: UUID, doc: DocumentCreate) -> UUID:
        """Upsert a document row and sync the tags junction table."""
        file_hash = hashlib.sha256(doc.content.encode()).hexdigest()

        columns = {
            "file_hash": file_hash,
            "title": doc.title,
            "author": doc.author,
            "url": doc.url,
            "origin": doc.origin,
            "published_date": doc.published_date,
            "genre": doc.genre,
            "compiled": doc.compiled,
            "doc_kind": doc.doc_kind,
            "source_type": doc.source_type,
            "precis": doc.precis,
        }

        stmt = (
            insert(DocumentORM)
            .values(
                brain_id=brain_id,
                file_path=doc.file_path,
                extra_metadata=doc.extra_metadata,
                **columns,
            )
            .on_conflict_do_update(
                constraint="documents_brain_id_file_path_key",
                set_={
                    **columns,
                    "metadata": doc.extra_metadata,
                    "updated_at": func.now(),
                },
            )
        )
        result = await self.session.execute(stmt.returning(DocumentORM.id))
        doc_id = result.scalar_one()

        await self._sync_tags(doc_id, doc.tags)

        return doc_id

    async def batch_upsert(
        self, brain_id: UUID, docs: list[DocumentCreate]
    ) -> list[UUID]:
        """Upsert multiple documents. Returns list of document UUIDs."""
        doc_ids = []
        for doc in docs:
            doc_id = await self.upsert(brain_id, doc)
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
        return Document.model_validate(row).model_copy(update={"tags": tags})

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
        return [Document.model_validate(r) for r in rows.scalars().all()]

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
            Document.model_validate(orm).model_copy(
                update={"tags": tags_by_doc[orm.id]}
            )
            for orm in docs
        ]

    async def get_content_type_counts(
        self, brain_ids: list[UUID]
    ) -> list[tuple[str, int]]:
        """Return (content_type, count) for raw documents grouped by folder.

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
        return [(row.content_type, row.cnt) for row in result]

    async def get_distinct_tags(self, brain_ids: list[UUID]) -> list[str]:
        result = await self.session.execute(
            select(distinct(DocumentTag.tag))
            .join(DocumentORM, DocumentORM.id == DocumentTag.document_id)
            .where(DocumentORM.brain_id.in_(brain_ids))
            .order_by(DocumentTag.tag)
        )
        return list(result.scalars().all())

