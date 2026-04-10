"""Document index repository: upsert, query, and backlink operations."""

import hashlib
from collections import defaultdict
from uuid import UUID

from sqlalchemy import delete, distinct, func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.core.brain import wiki_slug
from great_minds.core.brain_utils import extract_wiki_link_targets
from great_minds.core.documents.models import (
    BacklinkORM,
    DocumentConcept,
    DocumentInterlocutor,
    DocumentORM,
    DocumentTag,
)
from great_minds.core.documents.schemas import Document, DocumentCreate


class DocumentRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def upsert(self, brain_id: UUID, doc: DocumentCreate) -> UUID:
        """Upsert a document row and sync junction tables."""
        file_hash = hashlib.sha256(doc.content.encode()).hexdigest()
        published_date = str(doc.date) if doc.date is not None else None

        shared = {
            "file_hash": file_hash,
            "title": doc.title,
            "author": doc.author,
            "source_url": doc.source,
            "published_date": published_date,
            "genre": doc.genre,
            "tradition": doc.tradition,
            "compiled": doc.compiled,
            "doc_kind": doc.doc_kind,
        }

        stmt = (
            insert(DocumentORM)
            .values(
                brain_id=brain_id,
                file_path=doc.file_path,
                metadata_={},
                **shared,
            )
            .on_conflict_do_update(
                constraint="documents_brain_id_file_path_key",
                set_={**shared, "metadata": {}, "updated_at": func.now()},
            )
        )
        result = await self.session.execute(stmt.returning(DocumentORM.id))
        doc_id = result.scalar_one()

        await self._sync_junction(DocumentTag, "tag", doc_id, doc.tags)
        await self._sync_junction(DocumentConcept, "concept", doc_id, doc.concepts)
        await self._sync_junction(
            DocumentInterlocutor, "interlocutor", doc_id, doc.interlocutors
        )

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

    async def _sync_junction(
        self, model, value_col: str, doc_id: UUID, values: list[str]
    ) -> None:
        """Replace all junction rows for a document with the new set."""
        await self.session.execute(delete(model).where(model.document_id == doc_id))
        rows = [{"document_id": doc_id, value_col: val} for val in values if val]
        if rows:
            await self.session.execute(insert(model).values(rows))

    async def query_documents(
        self,
        brain_ids: list[UUID],
        *,
        tags: list[str] | None = None,
        concepts: list[str] | None = None,
        author: str | None = None,
        genre: str | None = None,
        compiled: bool | None = None,
        doc_kind: str | None = None,
        date_gte: str | None = None,
        date_lte: str | None = None,
        limit: int = 50,
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

        if concepts:
            concept_subq = (
                select(DocumentConcept.document_id)
                .where(DocumentConcept.concept.in_(concepts))
                .group_by(DocumentConcept.document_id)
                .having(func.count(distinct(DocumentConcept.concept)) >= len(concepts))
            )
            stmt = stmt.where(DocumentORM.id.in_(concept_subq))

        if author:
            stmt = stmt.where(DocumentORM.author.ilike(f"%{author}%"))
        if genre:
            stmt = stmt.where(DocumentORM.genre == genre)
        if compiled is not None:
            stmt = stmt.where(DocumentORM.compiled == compiled)
        if doc_kind:
            stmt = stmt.where(DocumentORM.doc_kind == doc_kind)
        if date_gte:
            stmt = stmt.where(DocumentORM.published_date >= date_gte)
        if date_lte:
            stmt = stmt.where(DocumentORM.published_date <= date_lte)

        stmt = stmt.order_by(DocumentORM.updated_at.desc()).limit(limit)

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
        concept_result = await self.session.execute(
            select(DocumentConcept.document_id, DocumentConcept.concept).where(
                DocumentConcept.document_id.in_(doc_ids)
            )
        )
        interlocutor_result = await self.session.execute(
            select(
                DocumentInterlocutor.document_id, DocumentInterlocutor.interlocutor
            ).where(DocumentInterlocutor.document_id.in_(doc_ids))
        )

        tags_by_doc: dict[UUID, list[str]] = defaultdict(list)
        for doc_id, tag in tag_result:
            tags_by_doc[doc_id].append(tag)

        concepts_by_doc: dict[UUID, list[str]] = defaultdict(list)
        for doc_id, concept in concept_result:
            concepts_by_doc[doc_id].append(concept)

        interlocutors_by_doc: dict[UUID, list[str]] = defaultdict(list)
        for doc_id, interlocutor in interlocutor_result:
            interlocutors_by_doc[doc_id].append(interlocutor)

        return [
            Document(
                id=orm.id,
                brain_id=orm.brain_id,
                file_path=orm.file_path,
                title=orm.title,
                author=orm.author,
                date=orm.published_date,
                source=orm.source_url,
                genre=orm.genre,
                tradition=orm.tradition,
                compiled=orm.compiled,
                doc_kind=orm.doc_kind,
                tags=tags_by_doc[orm.id],
                concepts=concepts_by_doc[orm.id],
                interlocutors=interlocutors_by_doc[orm.id],
                created_at=orm.created_at,
                updated_at=orm.updated_at,
            )
            for orm in docs
        ]

    async def get_distinct_tags(self, brain_ids: list[UUID]) -> list[str]:
        result = await self.session.execute(
            select(distinct(DocumentTag.tag))
            .join(DocumentORM, DocumentORM.id == DocumentTag.document_id)
            .where(DocumentORM.brain_id.in_(brain_ids))
            .order_by(DocumentTag.tag)
        )
        return list(result.scalars().all())

    async def get_distinct_concepts(self, brain_ids: list[UUID]) -> list[str]:
        result = await self.session.execute(
            select(distinct(DocumentConcept.concept))
            .join(DocumentORM, DocumentORM.id == DocumentConcept.document_id)
            .where(DocumentORM.brain_id.in_(brain_ids))
            .order_by(DocumentConcept.concept)
        )
        return list(result.scalars().all())

    async def upsert_backlinks(
        self,
        brain_id: UUID,
        source_slug: str,
        target_slugs: list[str],
    ) -> None:
        """Replace all outgoing backlinks for a source article."""
        await self.session.execute(
            delete(BacklinkORM).where(
                BacklinkORM.brain_id == brain_id,
                BacklinkORM.source_slug == source_slug,
            )
        )
        rows = [
            {"brain_id": brain_id, "source_slug": source_slug, "target_slug": t}
            for t in target_slugs
            if t != source_slug
        ]
        if rows:
            await self.session.execute(insert(BacklinkORM).values(rows))

    async def get_backlinks(self, brain_ids: list[UUID], target_slug: str) -> list[str]:
        """Return source slugs that link to the given target across brains."""
        result = await self.session.execute(
            select(BacklinkORM.source_slug).where(
                BacklinkORM.brain_id.in_(brain_ids),
                BacklinkORM.target_slug == target_slug,
            )
        )
        return list(result.scalars().all())

    async def rebuild_backlinks_for_article(
        self,
        brain_id: UUID,
        slug: str,
        article_content: str,
    ) -> None:
        """Parse outgoing wiki links from an article and upsert backlinks."""
        targets = [
            wiki_slug(path) for path in extract_wiki_link_targets(article_content)
        ]
        await self.upsert_backlinks(brain_id, slug, targets)
