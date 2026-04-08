"""Document index repository: upsert, query, and backlink operations."""

import hashlib
from collections import defaultdict
from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import delete, distinct, func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.core.brain import wiki_slug
from great_minds.core.brains._utils import extract_wiki_link_targets
from great_minds.core.documents.models import (
    BacklinkORM,
    DocumentConcept,
    DocumentInterlocutor,
    DocumentORM,
    DocumentTag,
)

DOC_KIND_RAW = "raw"
DOC_KIND_WIKI = "wiki"


@dataclass
class DocumentRow:
    id: UUID
    brain_id: UUID
    file_path: str
    title: str
    author: str | None
    source_type: str | None
    published_date: str | None
    genre: str | None
    tradition: str | None
    compiled: bool
    doc_kind: str
    tags: list[str]
    concepts: list[str]
    interlocutors: list[str]


class DocumentRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def upsert_document(
        self,
        brain_id: UUID,
        file_path: str,
        content: str,
        *,
        title: str = "",
        author: str | None = None,
        source_type: str | None = None,
        source_url: str | None = None,
        published_date: str | None = None,
        genre: str | None = None,
        tradition: str | None = None,
        compiled: bool = False,
        doc_kind: str = DOC_KIND_RAW,
        tags: list[str] | None = None,
        concepts: list[str] | None = None,
        interlocutors: list[str] | None = None,
        extra_metadata: dict | None = None,
    ) -> UUID:
        """Upsert a document row and sync junction tables."""
        file_hash = hashlib.sha256(content.encode()).hexdigest()

        stmt = insert(DocumentORM).values(
            brain_id=brain_id,
            file_path=file_path,
            file_hash=file_hash,
            title=title,
            author=author,
            source_type=source_type,
            source_url=source_url,
            published_date=published_date,
            genre=genre,
            tradition=tradition,
            compiled=compiled,
            doc_kind=doc_kind,
            metadata_=extra_metadata or {},
        )
        stmt = stmt.on_conflict_do_update(
            constraint="documents_brain_id_file_path_key",
            set_={
                "file_hash": file_hash,
                "title": title,
                "author": author,
                "source_type": source_type,
                "source_url": source_url,
                "published_date": published_date,
                "genre": genre,
                "tradition": tradition,
                "compiled": compiled,
                "doc_kind": doc_kind,
                "metadata": extra_metadata or {},
                "updated_at": func.now(),
            },
        )
        result = await self.session.execute(stmt.returning(DocumentORM.id))
        doc_id = result.scalar_one()

        await self._sync_junction(DocumentTag, "tag", doc_id, tags or [])
        await self._sync_junction(DocumentConcept, "concept", doc_id, concepts or [])
        await self._sync_junction(
            DocumentInterlocutor, "interlocutor", doc_id, interlocutors or []
        )

        return doc_id

    async def _sync_junction(
        self, model, value_col: str, doc_id: UUID, values: list[str]
    ) -> None:
        """Replace all junction rows for a document with the new set."""
        await self.session.execute(
            delete(model).where(model.document_id == doc_id)
        )
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
        source_type: str | None = None,
        genre: str | None = None,
        compiled: bool | None = None,
        doc_kind: str | None = None,
        date_gte: str | None = None,
        date_lte: str | None = None,
        limit: int = 50,
    ) -> list[DocumentRow]:
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
        if source_type:
            stmt = stmt.where(DocumentORM.source_type == source_type)
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

        # Batch-load junction data (3 queries total, not 3N)
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
            DocumentRow(
                id=doc.id,
                brain_id=doc.brain_id,
                file_path=doc.file_path,
                title=doc.title,
                author=doc.author,
                source_type=doc.source_type,
                published_date=doc.published_date,
                genre=doc.genre,
                tradition=doc.tradition,
                compiled=doc.compiled,
                doc_kind=doc.doc_kind,
                tags=tags_by_doc[doc.id],
                concepts=concepts_by_doc[doc.id],
                interlocutors=interlocutors_by_doc[doc.id],
            )
            for doc in docs
        ]

    async def get_distinct_tags(self, brain_ids: list[UUID]) -> list[str]:
        result = await self.session.execute(
            select(distinct(DocumentTag.tag))
            .join(DocumentORM, DocumentORM.id == DocumentTag.document_id)
            .where(DocumentORM.brain_id.in_(brain_ids))
            .order_by(DocumentTag.tag)
        )
        return result.scalars().all()

    async def get_distinct_concepts(self, brain_ids: list[UUID]) -> list[str]:
        result = await self.session.execute(
            select(distinct(DocumentConcept.concept))
            .join(DocumentORM, DocumentORM.id == DocumentConcept.document_id)
            .where(DocumentORM.brain_id.in_(brain_ids))
            .order_by(DocumentConcept.concept)
        )
        return result.scalars().all()

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

    async def get_backlinks(
        self, brain_ids: list[UUID], target_slug: str
    ) -> list[str]:
        """Return source slugs that link to the given target across brains."""
        result = await self.session.execute(
            select(BacklinkORM.source_slug).where(
                BacklinkORM.brain_id.in_(brain_ids),
                BacklinkORM.target_slug == target_slug,
            )
        )
        return result.scalars().all()

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
