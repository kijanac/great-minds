"""Source document and wiki article repositories."""

from uuid import UUID

from great_minds.core.hashing import body_hash, file_hash

from sqlalchemy import Select, delete, exists, func, or_, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.core.documents.models import (
    BacklinkORM,
    SourceDocumentORM,
    WikiArticleORM,
)
from great_minds.core.documents.schemas import (
    ArticleLink,
    Backlink,
    FileHash,
    SourceDocCreate,
    SourceDocument,
    WikiArticle,
    WikiArticleCreate,
    WikiArticleOverview,
    frontmatter_to_mirror_fields,
)
from great_minds.core.markdown import parse_frontmatter
from great_minds.core.pagination import FacetCount
from great_minds.core.paths import WIKI_INDEX_PATH, wiki_path


# Columns the ingest path writes. Zone-3 (LLM-derived) columns are
# deliberately excluded — extract owns those via ``reindex_from_file``.
# The on-conflict SET clause uses this same list so re-ingest can't
# clobber extract's output.
_INGEST_COLUMNS = (
    "file_hash",
    "body_hash",
    "client_hash",
    "source_type",
    "etag",
    "url",
    "origin",
    "provenance_session_id",
    "provenance_exchange_id",
    "provenance_session_query",
    "provenance_source_doc_path",
    "provenance_source_anchor",
    "provenance_source_paragraph_index",
    "provenance_anchored_to",
    "provenance_anchored_section",
    "provenance_intent",
)


def _ingest_row(doc: SourceDocCreate, vault_id: UUID) -> dict:
    """Project a SourceDocCreate into an ingest-write row dict."""
    fh = file_hash(doc.content)
    _, body = parse_frontmatter(doc.content)
    bh = body_hash(body)
    return {
        "vault_id": vault_id,
        "file_path": doc.file_path,
        "file_hash": fh,
        "body_hash": bh,
        "client_hash": doc.client_hash,
        "source_type": doc.source_type,
        "etag": doc.etag,
        "url": doc.url,
        "origin": doc.origin,
        "provenance_session_id": doc.provenance_session_id,
        "provenance_exchange_id": doc.provenance_exchange_id,
        "provenance_session_query": doc.provenance_session_query,
        "provenance_source_doc_path": doc.provenance_source_doc_path,
        "provenance_source_anchor": doc.provenance_source_anchor,
        "provenance_source_paragraph_index": doc.provenance_source_paragraph_index,
        "provenance_anchored_to": doc.provenance_anchored_to,
        "provenance_anchored_section": doc.provenance_anchored_section,
        "provenance_intent": doc.provenance_intent,
    }


class SourceDocumentRepo:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def upsert(self, vault_id: UUID, doc: SourceDocCreate) -> UUID:
        row = _ingest_row(doc, vault_id)
        stmt = insert(SourceDocumentORM).values(**row)
        stmt = stmt.on_conflict_do_update(
            index_elements=[SourceDocumentORM.vault_id, SourceDocumentORM.file_path],
            set_={col: stmt.excluded[col] for col in _INGEST_COLUMNS}
            | {"updated_at": func.now()},
        )
        result = await self.session.execute(stmt.returning(SourceDocumentORM.id))
        return result.scalar_one()

    async def batch_upsert(
        self, vault_id: UUID, docs: list[SourceDocCreate]
    ) -> list[UUID]:
        if not docs:
            return []
        rows = [_ingest_row(doc, vault_id) for doc in docs]
        stmt = insert(SourceDocumentORM).values(rows)
        stmt = stmt.on_conflict_do_update(
            index_elements=[SourceDocumentORM.vault_id, SourceDocumentORM.file_path],
            set_={col: stmt.excluded[col] for col in _INGEST_COLUMNS}
            | {"updated_at": func.now()},
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

    async def existing_client_hashes(
        self, vault_id: UUID, client_hashes: list[str]
    ) -> list[str]:
        """Return the subset of ``client_hashes`` already present in this vault.

        Used by the ingest dupe-check pre-flight so the UI can mark
        files as "already in vault" before uploading.
        """
        if not client_hashes:
            return []
        result = await self.session.execute(
            select(SourceDocumentORM.client_hash).where(
                SourceDocumentORM.vault_id == vault_id,
                SourceDocumentORM.client_hash.in_(client_hashes),
            )
        )
        return [h for h in result.scalars() if h is not None]

    async def refresh_etag_batch(self, etags: list[tuple[UUID, str]]) -> None:
        """Update etag for many docs in one prepared-statement executemany.

        Single-column write owned by ingest. The vault_id constraint is
        implicit — callers pass ids resolved from the vault.
        """
        if not etags:
            return
        await self.session.execute(
            update(SourceDocumentORM).values(updated_at=func.now()),
            [{"id": doc_id, "etag": etag} for doc_id, etag in etags],
        )

    async def reindex_from_file(self, doc_id: UUID, file_content: str) -> None:
        """Reflect a file's frontmatter into the doc's Zone-3 mirror columns.

        The single canonical ``file → row`` translator. Frontmatter is
        canonical; this row write derives from it. Each value flows
        through its column's type descriptor (executemany over one
        dict), so arrays/JSONB don't lose type information the way the
        prior CASE-WHEN build did.
        """
        fm, _ = parse_frontmatter(file_content)
        payload = frontmatter_to_mirror_fields(fm)
        await self.session.execute(
            update(SourceDocumentORM).values(updated_at=func.now()),
            [{"id": doc_id, **payload}],
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

    async def query(
        self,
        vault_ids: list[UUID],
        *,
        tags: list[str] | None = None,
        author: str | None = None,
        genre: str | None = None,
        source_type: str | None = None,
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
            source_type=source_type,
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
        source_type: str | None = None,
        search: str | None = None,
        date_gte: str | None = None,
        date_lte: str | None = None,
    ) -> int:
        filtered = _source_document_query(
            vault_ids,
            tags=tags,
            author=author,
            genre=genre,
            source_type=source_type,
            search=search,
            date_gte=date_gte,
            date_lte=date_lte,
        ).subquery()
        return (
            await self.session.scalar(select(func.count()).select_from(filtered))
        ) or 0

    async def source_type_counts(self, vault_ids: list[UUID]) -> list[FacetCount]:
        """Counts per source_type for faceted source listings."""
        result = await self.session.execute(
            select(SourceDocumentORM.source_type, func.count().label("cnt"))
            .where(SourceDocumentORM.vault_id.in_(vault_ids))
            .group_by(SourceDocumentORM.source_type)
            .order_by(func.count().desc())
        )
        return [FacetCount(value=row.source_type, count=row.cnt) for row in result]

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
            tags=article.tags,
            render_run_id=article.render_run_id,
        )
        stmt = stmt.on_conflict_do_update(
            index_elements=[WikiArticleORM.topic_id],
            set_={
                "file_path": article.file_path,
                "file_hash": fh,
                "body_hash": bh,
                "title": article.title,
                "precis": article.precis,
                "tags": article.tags,
                "render_run_id": article.render_run_id,
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
        render_run_id: UUID | None = None,
        limit: int = 50,
        offset: int = 0,
        recent: bool = False,
    ) -> list[WikiArticleOverview]:
        stmt = select(WikiArticleORM).where(
            WikiArticleORM.vault_id == vault_id,
            WikiArticleORM.file_path != WIKI_INDEX_PATH,
            WikiArticleORM.archived.is_(False),
        )
        if slug is not None:
            stmt = stmt.where(WikiArticleORM.file_path == wiki_path(slug))
        if render_run_id is not None:
            stmt = stmt.where(WikiArticleORM.render_run_id == render_run_id)
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

    async def count_overview_paths(
        self, vault_id: UUID, *, render_run_id: UUID | None = None
    ) -> int:
        stmt = select(func.count()).where(
            WikiArticleORM.vault_id == vault_id,
            WikiArticleORM.file_path != WIKI_INDEX_PATH,
            WikiArticleORM.archived.is_(False),
        )
        if render_run_id is not None:
            stmt = stmt.where(WikiArticleORM.render_run_id == render_run_id)
        return (await self.session.scalar(stmt)) or 0

    async def list_orphans(self, vault_id: UUID) -> list[WikiArticleOverview]:
        """Live articles with zero inbound backlinks.

        Anti-join (``NOT EXISTS``) rather than ``OUTER JOIN + GROUP BY +
        HAVING COUNT()=0``: the planner can short-circuit on the first
        matching backlink instead of aggregating every edge per article.
        """
        no_backlink = ~exists().where(
            BacklinkORM.target_article_id == WikiArticleORM.id
        )
        rows = (
            await self.session.scalars(
                select(WikiArticleORM)
                .where(
                    WikiArticleORM.vault_id == vault_id,
                    WikiArticleORM.file_path != WIKI_INDEX_PATH,
                    WikiArticleORM.archived.is_(False),
                    no_backlink,
                )
                .order_by(func.lower(WikiArticleORM.title))
            )
        ).all()
        return [WikiArticleOverview.model_validate(orm) for orm in rows]

    async def archive_article(
        self, vault_id: UUID, topic_id: UUID, archive_path: str
    ) -> None:
        """Repoint a topic's article at its archive location and flag it.

        Called when validate archives a superseded topic: the file has
        moved under archive/, so the row points there and ``archived``
        excludes it from the wiki list and orphan lint.
        """
        await self.session.execute(
            update(WikiArticleORM)
            .where(
                WikiArticleORM.vault_id == vault_id,
                WikiArticleORM.topic_id == topic_id,
            )
            .values(file_path=archive_path, archived=True)
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

    async def linked_articles(
        self, vault_id: UUID, path: str
    ) -> tuple[list[ArticleLink], list[ArticleLink]] | None:
        """Live articles ``path`` links to (outgoing) and that link to it.

        Read from the prose-derived ``backlinks`` edge table — outgoing is
        the source side, incoming the target side of the same directed
        edges, so no topic-level intent is involved. Returns ``None`` when
        ``path`` is not a wiki article. Archived articles are excluded.
        """
        article_id = await self.session.scalar(
            select(WikiArticleORM.id).where(
                WikiArticleORM.vault_id == vault_id,
                WikiArticleORM.file_path == path,
            )
        )
        if article_id is None:
            return None

        outgoing = await self.session.execute(
            select(WikiArticleORM.file_path, WikiArticleORM.title)
            .join(BacklinkORM, BacklinkORM.target_article_id == WikiArticleORM.id)
            .where(
                BacklinkORM.source_article_id == article_id,
                ~WikiArticleORM.archived,
            )
            .order_by(WikiArticleORM.title)
        )
        incoming = await self.session.execute(
            select(WikiArticleORM.file_path, WikiArticleORM.title)
            .join(BacklinkORM, BacklinkORM.source_article_id == WikiArticleORM.id)
            .where(
                BacklinkORM.target_article_id == article_id,
                ~WikiArticleORM.archived,
            )
            .order_by(WikiArticleORM.title)
        )
        return (
            [ArticleLink(path=p, title=t) for p, t in outgoing],
            [ArticleLink(path=p, title=t) for p, t in incoming],
        )


def _source_document_query(
    vault_ids: list[UUID],
    *,
    tags: list[str] | None = None,
    author: str | None = None,
    genre: str | None = None,
    source_type: str | None = None,
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
    if source_type:
        stmt = stmt.where(SourceDocumentORM.source_type == source_type)
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
