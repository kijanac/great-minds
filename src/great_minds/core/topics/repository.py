"""Topic registry CRUD.

Used by pipeline phases (derive, render, verify, publish) and by
route-level services (wiki endpoints). Keeps queries narrow; business
logic around slug continuity / archive lives in topics.service.
"""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import delete, func, or_, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.core.topics.models import (
    TopicLinkORM,
    TopicMembershipORM,
    TopicORM,
    TopicRelatedORM,
)
from great_minds.core.topics.schemas import ArticleStatus, RelatedTopic, Topic, TopicLink


class TopicRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    # -- Topic CRUD --------------------------------------------------------

    async def upsert(
        self,
        *,
        topic_id: UUID,
        vault_id: UUID,
        slug: str,
        title: str,
        description: str,
        compiled_from_hash: str | None,
    ) -> None:
        """Insert or update a canonical topic row.

        article_status is NOT touched here — it's managed by the archive
        / render flows (set_archived, set_rendered). supersedes /
        superseded_by are set explicitly by the archive flow.
        """
        stmt = (
            insert(TopicORM)
            .values(
                topic_id=topic_id,
                vault_id=vault_id,
                slug=slug,
                title=title,
                description=description,
                compiled_from_hash=compiled_from_hash,
            )
            .on_conflict_do_update(
                index_elements=[TopicORM.topic_id],
                set_={
                    "slug": slug,
                    "title": title,
                    "description": description,
                    "compiled_from_hash": compiled_from_hash,
                },
            )
        )
        await self.session.execute(stmt)

    async def get_by_slug(self, vault_id: UUID, slug: str) -> Topic | None:
        row = (
            await self.session.execute(
                select(TopicORM).where(
                    TopicORM.vault_id == vault_id, TopicORM.slug == slug
                )
            )
        ).scalar_one_or_none()
        return Topic.model_validate(row) if row is not None else None

    async def get_by_id(self, topic_id: UUID) -> Topic | None:
        row = (
            await self.session.execute(
                select(TopicORM).where(TopicORM.topic_id == topic_id)
            )
        ).scalar_one_or_none()
        return Topic.model_validate(row) if row is not None else None

    async def list_by_status(
        self, vault_id: UUID, status: ArticleStatus
    ) -> list[Topic]:
        rows = (
            await self.session.execute(
                select(TopicORM)
                .where(
                    TopicORM.vault_id == vault_id,
                    TopicORM.article_status == status.value,
                )
                .order_by(TopicORM.title)
            )
        ).scalars().all()
        return [Topic.model_validate(r) for r in rows]

    async def list_all(self, vault_id: UUID) -> list[Topic]:
        rows = (
            await self.session.execute(
                select(TopicORM)
                .where(TopicORM.vault_id == vault_id)
                .order_by(TopicORM.title)
            )
        ).scalars().all()
        return [Topic.model_validate(r) for r in rows]

    async def count_all(self, vault_id: UUID) -> int:
        return (
            await self.session.scalar(
                select(func.count())
                .select_from(TopicORM)
                .where(TopicORM.vault_id == vault_id)
            )
        ) or 0

    async def count_by_status(
        self, vault_id: UUID, status: ArticleStatus
    ) -> int:
        return (
            await self.session.scalar(
                select(func.count())
                .select_from(TopicORM)
                .where(
                    TopicORM.vault_id == vault_id,
                    TopicORM.article_status == status.value,
                )
            )
        ) or 0

    async def list_dirty_topic_ids(self, vault_id: UUID) -> list[UUID]:
        """Return topic_ids whose rendered output lags the compiled inputs.

        Non-archived topics where rendered_from_hash is NULL (never
        rendered) or differs from compiled_from_hash (inputs shifted
        since last render).
        """
        result = await self.session.execute(
            select(TopicORM.topic_id)
            .where(
                TopicORM.vault_id == vault_id,
                TopicORM.article_status != ArticleStatus.ARCHIVED.value,
                TopicORM.compiled_from_hash.is_not(None),
                or_(
                    TopicORM.rendered_from_hash.is_(None),
                    TopicORM.rendered_from_hash != TopicORM.compiled_from_hash,
                ),
            )
        )
        return [row.topic_id for row in result]

    async def count_dirty(self, vault_id: UUID) -> int:
        """Non-archived topics whose rendered output lags the compiled inputs."""
        return (
            await self.session.scalar(
                select(func.count())
                .select_from(TopicORM)
                .where(
                    TopicORM.vault_id == vault_id,
                    TopicORM.article_status != ArticleStatus.ARCHIVED.value,
                    TopicORM.compiled_from_hash.is_not(None),
                    or_(
                        TopicORM.rendered_from_hash.is_(None),
                        TopicORM.rendered_from_hash != TopicORM.compiled_from_hash,
                    ),
                )
            )
        ) or 0

    async def list_links_for_vault(
        self, vault_id: UUID, source_topic_ids: list[UUID] | None = None
    ) -> list[TopicLink]:
        """Return directed link edges for a vault.

        Pass source_topic_ids to restrict to edges whose source is in
        the set (e.g., rendered topics only).
        """
        stmt = (
            select(TopicLinkORM.source_topic_id, TopicLinkORM.target_topic_id)
            .join(TopicORM, TopicORM.topic_id == TopicLinkORM.source_topic_id)
            .where(TopicORM.vault_id == vault_id)
        )
        if source_topic_ids is not None:
            stmt = stmt.where(TopicLinkORM.source_topic_id.in_(source_topic_ids))
        rows = (await self.session.execute(stmt)).all()
        return [
            TopicLink(source_topic_id=src, target_topic_id=tgt)
            for src, tgt in rows
        ]

    async def set_archived(
        self, topic_id: UUID, superseded_by: UUID | None = None
    ) -> None:
        await self.session.execute(
            TopicORM.__table__.update()
            .where(TopicORM.topic_id == topic_id)
            .values(
                article_status=ArticleStatus.ARCHIVED.value,
                superseded_by=superseded_by,
            )
        )

    async def set_rendered(self, topic_id: UUID, rendered_from_hash: str) -> None:
        await self.session.execute(
            TopicORM.__table__.update()
            .where(TopicORM.topic_id == topic_id)
            .values(
                article_status=ArticleStatus.RENDERED.value,
                rendered_from_hash=rendered_from_hash,
            )
        )

    # -- Membership --------------------------------------------------------

    async def replace_membership(self, topic_id: UUID, idea_ids: list[UUID]) -> None:
        await self.session.execute(
            delete(TopicMembershipORM).where(TopicMembershipORM.topic_id == topic_id)
        )
        if idea_ids:
            await self.session.execute(
                insert(TopicMembershipORM).values(
                    [{"topic_id": topic_id, "idea_id": i} for i in idea_ids]
                )
            )

    async def get_membership(self, topic_id: UUID) -> list[UUID]:
        rows = (
            await self.session.execute(
                select(TopicMembershipORM.idea_id).where(
                    TopicMembershipORM.topic_id == topic_id
                )
            )
        ).scalars().all()
        return list(rows)

    # -- Topic links (intent from reduce) ----------------------------------

    async def replace_links_for_vault(
        self, vault_id: UUID, edges: list[tuple[UUID, UUID]]
    ) -> None:
        """Replace every outgoing edge rooted at this vault's topics.

        Implemented by deleting any edge whose source belongs to this
        vault, then bulk-inserting the new set.
        """
        vault_topic_ids = (
            await self.session.execute(
                select(TopicORM.topic_id).where(TopicORM.vault_id == vault_id)
            )
        ).scalars().all()
        if vault_topic_ids:
            await self.session.execute(
                delete(TopicLinkORM).where(
                    TopicLinkORM.source_topic_id.in_(list(vault_topic_ids))
                )
            )
        if edges:
            await self.session.execute(
                insert(TopicLinkORM).values(
                    [{"source_topic_id": s, "target_topic_id": t} for s, t in edges]
                )
            )

    async def get_links_from(self, topic_id: UUID) -> list[UUID]:
        rows = (
            await self.session.execute(
                select(TopicLinkORM.target_topic_id).where(
                    TopicLinkORM.source_topic_id == topic_id
                )
            )
        ).scalars().all()
        return list(rows)

    # -- Related (sidebar UI) ----------------------------------------------

    async def replace_related(
        self,
        topic_id: UUID,
        rows: list[tuple[UUID, int, float]],
    ) -> None:
        await self.session.execute(
            delete(TopicRelatedORM).where(TopicRelatedORM.topic_id == topic_id)
        )
        if rows:
            await self.session.execute(
                insert(TopicRelatedORM).values(
                    [
                        {
                            "topic_id": topic_id,
                            "related_topic_id": rid,
                            "shared_ideas": shared,
                            "jaccard": j,
                        }
                        for rid, shared, j in rows
                    ]
                )
            )

    async def get_related(
        self, topic_id: UUID, limit: int = 20
    ) -> list[RelatedTopic]:
        rows = (
            await self.session.execute(
                select(TopicRelatedORM)
                .where(TopicRelatedORM.topic_id == topic_id)
                .order_by(TopicRelatedORM.jaccard.desc())
                .limit(limit)
            )
        ).scalars().all()
        return [RelatedTopic.model_validate(r) for r in rows]
