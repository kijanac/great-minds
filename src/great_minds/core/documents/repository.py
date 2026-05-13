"""Source document and wiki article repositories."""

from uuid import UUID

from great_minds.core.hashing import body_hash, file_hash

from sqlalchemy import Select, case, delete, func, or_, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.core.documents.models import (
    BacklinkORM,
    SourceDocumentORM,
    WikiArticleORM,
)
from great_minds.core.documents.schemas import (
    Backlink,
    FileHash,
    SourceDocCreate,
    SourceDocument,
    SourceDocumentUpdate,
    WikiArticle,
    WikiArticleCreate,
    WikiArticleOverview,
)
from great_minds.core.ideas.schemas import SourceCard
from great_minds.core.markdown import parse_frontmatter
from great_minds.core.pagination import FacetCount
from great_minds.core.paths import WIKI_INDEX_PATH, raw_prefix, wiki_path


class SourceDocumentRepo:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def upsert(self, vault_id: UUID, doc: SourceDocCreate) -> UUID:
        file_hash_val = file_hash(doc.content)
        _, body = parse_frontmatter(doc.content)
        body_hash_val = body_hash(body)

        columns = {
            "file_hash": file_hash_val,
            "body_hash": body_hash_val,
            "title": doc.metadata.title,
            "author": doc.metadata.author,
            "url": doc.metadata.url,
            "origin": doc.metadata.origin,
            "published_date": doc.metadata.published_date,
            "genre": doc.metadata.genre,
            "compiled": doc.compiled,
            "source_type": doc.metadata.source_type,
            "precis": doc.metadata.precis,
            "tags": doc.metadata.tags,
        }
        meta_dump = doc.metadata.doc_metadata.model_dump()
        stmt = insert(SourceDocumentORM).values(
            vault_id=vault_id,
            file_path=doc.file_path,
            doc_metadata=meta_dump,
            **columns,
        )
        stmt = stmt.on_conflict_do_update(
            index_elements=[SourceDocumentORM.vault_id, SourceDocumentORM.file_path],
            set_={
                **columns,
                "metadata": meta_dump,
                "updated_at": func.now(),
            },
        )
        result = await self.session.execute(stmt.returning(SourceDocumentORM.id))
        return result.scalar_one()

    async def batch_upsert(
        self, vault_id: UUID, docs: list[SourceDocCreate]
    ) -> list[UUID]:
        if not docs:
            return []
        rows = []
        for doc in docs:
            fh = file_hash(doc.content)
            _, body = parse_frontmatter(doc.content)
            bh = body_hash(body)
            rows.append(
                {
                    "vault_id": vault_id,
                    "file_path": doc.file_path,
                    "file_hash": fh,
                    "body_hash": bh,
                    "title": doc.metadata.title,
                    "author": doc.metadata.author,
                    "url": doc.metadata.url,
                    "origin": doc.metadata.origin,
                    "published_date": doc.metadata.published_date,
                    "genre": doc.metadata.genre,
                    "compiled": doc.compiled,
                    "etag": doc.etag,
                    "source_type": doc.metadata.source_type,
                    "precis": doc.metadata.precis,
                    "tags": doc.metadata.tags,
                    "doc_metadata": doc.metadata.doc_metadata.model_dump(),
                }
            )
        stmt = insert(SourceDocumentORM).values(rows)
        stmt = stmt.on_conflict_do_update(
            index_elements=[SourceDocumentORM.vault_id, SourceDocumentORM.file_path],
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
                "etag": stmt.excluded.etag,
                "source_type": stmt.excluded.source_type,
                "precis": stmt.excluded.precis,
                "tags": stmt.excluded.tags,
                "metadata": stmt.excluded["metadata"],
                "updated_at": func.now(),
            },
        )
        result = await self.session.execute(
            stmt.returning(SourceDocumentORM.id, SourceDocumentORM.file_path)
        )
        id_by_path = {row.file_path: row.id for row in result}
        return [id_by_path[doc.file_path] for doc in docs]

    async def get_file_hashes(self, vault_id: UUID) -> list[FileHash]:
        result = await self.session.execute(
            select(SourceDocumentORM.file_path, SourceDocumentORM.file_hash).where(
                SourceDocumentORM.vault_id == vault_id
            )
        )
        return [FileHash.model_validate(r) for r in result]

    async def update_batch(
        self, vault_id: UUID, updates: list[SourceDocumentUpdate]
    ) -> None:
        """Batch-update source documents."""
        if not updates:
            return
        ids = [u.document_id for u in updates]
        values: dict = {"updated_at": func.now()}
        for attr in ("etag", "title", "precis", "doc_metadata"):
            mapping: dict = {}
            for u in updates:
                v = getattr(u, attr)
                if v is None:
                    continue
                mapping[u.document_id] = v.model_dump() if attr == "doc_metadata" else v
            if mapping:
                values[attr] = case(mapping, value=SourceDocumentORM.id)
        await self.session.execute(
            update(SourceDocumentORM)
            .where(
                SourceDocumentORM.vault_id == vault_id,
                SourceDocumentORM.id.in_(ids),
            )
            .values(**values)
        )

    async def get_by_path(
        self, vault_id: UUID, file_path: str
    ) -> SourceDocument | None:
        row = await self.session.scalar(
            select(SourceDocumentORM).where(
                SourceDocumentORM.vault_id == vault_id,
                SourceDocumentORM.file_path == file_path,
            )
        )
        return SourceDocument.model_validate(row) if row is not None else None

    async def get_title_by_path(self, vault_id: UUID, file_path: str) -> str | None:
        return (
            await self.session.scalar(
                select(SourceDocumentORM.title).where(
                    SourceDocumentORM.vault_id == vault_id,
                    SourceDocumentORM.file_path == file_path,
                )
            )
            or None
        )

    async def list_all(self, vault_id: UUID) -> list[SourceDocument]:
        rows = await self.session.execute(
            select(SourceDocumentORM)
            .where(SourceDocumentORM.vault_id == vault_id)
            .order_by(SourceDocumentORM.file_path)
        )
        return [SourceDocument.model_validate(r) for r in rows.scalars().all()]

    async def count(self, vault_id: UUID) -> int:
        return (
            await self.session.scalar(
                select(func.count())
                .select_from(SourceDocumentORM)
                .where(SourceDocumentORM.vault_id == vault_id)
            )
        ) or 0

    async def update_metadata_from_cards(
        self, vault_id: UUID, cards: list[SourceCard]
    ) -> None:
        await self.update_batch(
            vault_id,
            [SourceDocumentUpdate.model_validate(c) for c in cards],
        )

    async def query(
        self,
        vault_ids: list[UUID],
        *,
        tags: list[str] | None = None,
        author: str | None = None,
        genre: str | None = None,
        compiled: bool | None = None,
        source_type: str | None = None,
        content_type: str | None = None,
        search: str | None = None,
        date_gte: str | None = None,
        date_lte: str | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> list[SourceDocument]:
        stmt = _source_document_query(
            vault_ids,
            tags=tags,
            author=author,
            genre=genre,
            compiled=compiled,
            source_type=source_type,
            content_type=content_type,
            search=search,
            date_gte=date_gte,
            date_lte=date_lte,
        )
        stmt = (
            stmt.order_by(SourceDocumentORM.updated_at.desc())
            .offset(offset)
            .limit(limit)
        )
        docs = (await self.session.execute(stmt)).scalars().all()
        return [SourceDocument.model_validate(d) for d in docs]

    async def count_query(
        self,
        vault_ids: list[UUID],
        *,
        tags: list[str] | None = None,
        author: str | None = None,
        genre: str | None = None,
        compiled: bool | None = None,
        source_type: str | None = None,
        content_type: str | None = None,
        search: str | None = None,
        date_gte: str | None = None,
        date_lte: str | None = None,
    ) -> int:
        filtered = _source_document_query(
            vault_ids,
            tags=tags,
            author=author,
            genre=genre,
            compiled=compiled,
            source_type=source_type,
            content_type=content_type,
            search=search,
            date_gte=date_gte,
            date_lte=date_lte,
        ).subquery()
        return (
            await self.session.scalar(select(func.count()).select_from(filtered))
        ) or 0

    async def content_type_counts(self, vault_ids: list[UUID]) -> list[FacetCount]:
        ct_col = func.split_part(SourceDocumentORM.file_path, "/", 2).label(
            "content_type"
        )
        result = await self.session.execute(
            select(ct_col, func.count().label("cnt"))
            .where(SourceDocumentORM.vault_id.in_(vault_ids))
            .group_by(ct_col)
            .order_by(func.count().desc())
        )
        return [FacetCount(value=row.content_type, count=row.cnt) for row in result]

    async def distinct_tags(self, vault_ids: list[UUID]) -> list[str]:
        tag_col = func.unnest(SourceDocumentORM.tags).label("tag")
        stmt = (
            select(tag_col)
            .where(SourceDocumentORM.vault_id.in_(vault_ids))
            .distinct()
            .order_by(tag_col)
        )
        result = await self.session.execute(stmt)
        return list(result.scalars().all())


# ---------------------------------------------------------------------------
# Wiki articles
# ---------------------------------------------------------------------------


class WikiArticleRepo:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def upsert(self, vault_id: UUID, article: WikiArticleCreate) -> UUID:
        fh = file_hash(article.content)
        _, body = parse_frontmatter(article.content)
        bh = body_hash(body)
        stmt = insert(WikiArticleORM).values(
            vault_id=vault_id,
            topic_id=article.topic_id,
            file_path=article.file_path,
            file_hash=fh,
            body_hash=bh,
            title=article.title,
            precis=article.precis,
        )
        stmt = stmt.on_conflict_do_update(
            index_elements=[WikiArticleORM.topic_id],
            set_={
                "file_path": article.file_path,
                "file_hash": fh,
                "body_hash": bh,
                "title": article.title,
                "precis": article.precis,
                "updated_at": func.now(),
            },
        )
        result = await self.session.execute(stmt.returning(WikiArticleORM.id))
        return result.scalar_one()

    async def get_by_path(self, vault_id: UUID, file_path: str) -> WikiArticle | None:
        orm = await self.session.scalar(
            select(WikiArticleORM).where(
                WikiArticleORM.vault_id == vault_id,
                WikiArticleORM.file_path == file_path,
            )
        )
        return WikiArticle.model_validate(orm) if orm is not None else None

    async def get_by_topic(self, vault_id: UUID, topic_id: UUID) -> WikiArticle | None:
        orm = await self.session.scalar(
            select(WikiArticleORM).where(
                WikiArticleORM.vault_id == vault_id,
                WikiArticleORM.topic_id == topic_id,
            )
        )
        return WikiArticle.model_validate(orm) if orm is not None else None

    async def list_all(self, vault_id: UUID) -> list[WikiArticle]:
        rows = await self.session.scalars(
            select(WikiArticleORM)
            .where(WikiArticleORM.vault_id == vault_id)
            .order_by(WikiArticleORM.file_path)
        )
        return [WikiArticle.model_validate(orm) for orm in rows.all()]

    async def count(self, vault_id: UUID) -> int:
        return (
            await self.session.scalar(
                select(func.count())
                .select_from(WikiArticleORM)
                .where(WikiArticleORM.vault_id == vault_id)
            )
        ) or 0

    async def get_title_by_path(self, vault_id: UUID, file_path: str) -> str | None:
        title = await self.session.scalar(
            select(WikiArticleORM.title).where(
                WikiArticleORM.vault_id == vault_id,
                WikiArticleORM.file_path == file_path,
            )
        )
        return title or None

    async def list_overviews(
        self,
        vault_id: UUID,
        *,
        slug: str | None = None,
        query: str | None = None,
        limit: int = 50,
        offset: int = 0,
        recent: bool = False,
    ) -> list[WikiArticleOverview]:
        stmt = select(WikiArticleORM).where(
            WikiArticleORM.vault_id == vault_id,
            WikiArticleORM.file_path != WIKI_INDEX_PATH,
        )
        if slug is not None:
            stmt = stmt.where(WikiArticleORM.file_path == wiki_path(slug))
        if query:
            pattern = f"%{query.lower()}%"
            stmt = stmt.where(
                or_(
                    func.lower(WikiArticleORM.title).like(pattern),
                    func.lower(WikiArticleORM.precis).like(pattern),
                )
            )
        stmt = stmt.order_by(
            WikiArticleORM.updated_at.desc()
            if recent
            else func.lower(WikiArticleORM.title)
        )
        rows = (await self.session.scalars(stmt.offset(offset).limit(limit))).all()
        return [WikiArticleOverview.model_validate(orm) for orm in rows]

    async def count_overview_paths(self, vault_id: UUID) -> int:
        return (
            await self.session.scalar(
                select(func.count()).where(
                    WikiArticleORM.vault_id == vault_id,
                    WikiArticleORM.file_path != WIKI_INDEX_PATH,
                )
            )
        ) or 0

    async def list_orphans(self, vault_id: UUID) -> list[WikiArticleOverview]:
        rows = (
            await self.session.scalars(
                select(WikiArticleORM)
                .outerjoin(
                    BacklinkORM,
                    BacklinkORM.target_article_id == WikiArticleORM.id,
                )
                .where(
                    WikiArticleORM.vault_id == vault_id,
                    WikiArticleORM.file_path != WIKI_INDEX_PATH,
                )
                .group_by(WikiArticleORM.id)
                .having(func.count(BacklinkORM.source_article_id) == 0)
                .order_by(func.lower(WikiArticleORM.title))
            )
        ).all()
        return [WikiArticleOverview.model_validate(orm) for orm in rows]

    async def update_file_path_for_topic(
        self, vault_id: UUID, topic_id: UUID, new_file_path: str
    ) -> None:
        await self.session.execute(
            update(WikiArticleORM)
            .where(
                WikiArticleORM.vault_id == vault_id,
                WikiArticleORM.topic_id == topic_id,
            )
            .values(file_path=new_file_path)
        )

    async def update_backlinks(
        self,
        source_ids: list[UUID],
        backlinks: list[Backlink],
    ) -> None:
        if not source_ids:
            return
        await self.session.execute(
            delete(BacklinkORM).where(BacklinkORM.source_article_id.in_(source_ids))
        )
        if backlinks:
            await self.session.execute(
                insert(BacklinkORM).values([b.model_dump() for b in backlinks])
            )

    async def count_by_search(
        self, vault_ids: list[UUID], *, search: str | None = None
    ) -> int:
        stmt = (
            select(func.count())
            .select_from(WikiArticleORM)
            .where(WikiArticleORM.vault_id.in_(vault_ids))
        )
        if search:
            pattern = f"%{search.lower()}%"
            stmt = stmt.where(
                func.lower(WikiArticleORM.title).like(pattern)
                | func.lower(WikiArticleORM.precis).like(pattern)
            )
        return (await self.session.scalar(stmt)) or 0


def _source_document_query(
    vault_ids: list[UUID],
    *,
    tags: list[str] | None = None,
    author: str | None = None,
    genre: str | None = None,
    compiled: bool | None = None,
    source_type: str | None = None,
    content_type: str | None = None,
    search: str | None = None,
    date_gte: str | None = None,
    date_lte: str | None = None,
) -> Select[tuple[SourceDocumentORM]]:
    stmt = select(SourceDocumentORM).where(SourceDocumentORM.vault_id.in_(vault_ids))
    if tags:
        stmt = stmt.where(SourceDocumentORM.tags.contains(tags))
    if author:
        stmt = stmt.where(SourceDocumentORM.author.ilike(f"%{author}%"))
    if genre:
        stmt = stmt.where(SourceDocumentORM.genre == genre)
    if compiled is not None:
        stmt = stmt.where(SourceDocumentORM.compiled == compiled)
    if source_type:
        stmt = stmt.where(SourceDocumentORM.source_type == source_type)
    if content_type:
        stmt = stmt.where(
            SourceDocumentORM.file_path.like(f"{raw_prefix(content_type)}/%")
        )
    if search:
        stmt = stmt.where(
            SourceDocumentORM.title.ilike(f"%{search}%")
            | SourceDocumentORM.author.ilike(f"%{search}%")
        )
    if date_gte:
        stmt = stmt.where(SourceDocumentORM.published_date >= date_gte)
    if date_lte:
        stmt = stmt.where(SourceDocumentORM.published_date <= date_lte)
    return stmt
