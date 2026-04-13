"""Document index repository: upsert, query, and backlink operations."""

import hashlib
from collections import defaultdict
from uuid import UUID

from sqlalchemy import delete, distinct, func, select, type_coerce
from sqlalchemy.dialects.postgresql import JSONB, insert
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.core.brain import wiki_slug
from great_minds.core.brain_utils import extract_wiki_link_targets
from great_minds.core.documents.models import (
    BacklinkORM,
    DocumentORM,
    DocumentTag,
)
from great_minds.core.documents.schemas import DocKind, Document, DocumentCreate


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
        concepts: list[str] | None = None,
        author: str | None = None,
        genre: str | None = None,
        compiled: bool | None = None,
        doc_kind: DocKind | None = None,
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

        if concepts:
            # JSONB @> containment — uses the GIN index
            stmt = stmt.where(
                DocumentORM.extra_metadata.op("@>")(
                    type_coerce({"concepts": concepts}, JSONB)
                )
            )

        if author:
            stmt = stmt.where(DocumentORM.author.ilike(f"%{author}%"))
        if genre:
            stmt = stmt.where(DocumentORM.genre == genre)
        if compiled is not None:
            stmt = stmt.where(DocumentORM.compiled == compiled)
        if doc_kind:
            stmt = stmt.where(DocumentORM.doc_kind == doc_kind)
        if content_type:
            stmt = stmt.where(DocumentORM.file_path.like(f"raw/{content_type}/%"))
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

    async def get_distinct_concepts(self, brain_ids: list[UUID]) -> list[str]:
        """Extract distinct concepts from JSONB metadata across brains."""
        # Query JSONB array elements
        result = await self.session.execute(
            select(
                func.jsonb_array_elements_text(
                    DocumentORM.extra_metadata["concepts"]
                ).label("concept")
            )
            .where(
                DocumentORM.brain_id.in_(brain_ids),
                func.jsonb_typeof(DocumentORM.extra_metadata["concepts"]) == "array",
            )
            .distinct()
        )
        return sorted(result.scalars().all())

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
