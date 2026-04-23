"""Backlinks CRUD.

Written by phase 5 verify from actual citations in rendered prose,
read by the lint endpoint + future wiki-page backlink display.
"""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.core.articles.models import BacklinkORM
from great_minds.core.topics.models import TopicORM


class BacklinkRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def replace_for_brain(
        self,
        brain_id: UUID,
        rows: list[tuple[UUID, UUID, str]],
    ) -> None:
        """Replace every backlink edge rooted at this brain's topics.

        rows: list of (target_topic_id, source_topic_id, source_article_path).
        BacklinkORM FKs to topics via both columns, so brain scoping is
        via the topics table join.
        """
        brain_topic_ids = (
            await self.session.execute(
                select(TopicORM.topic_id).where(TopicORM.brain_id == brain_id)
            )
        ).scalars().all()
        if brain_topic_ids:
            await self.session.execute(
                delete(BacklinkORM).where(
                    BacklinkORM.source_topic_id.in_(list(brain_topic_ids))
                )
            )
        if rows:
            await self.session.execute(
                insert(BacklinkORM).values(
                    [
                        {
                            "target_topic_id": t,
                            "source_topic_id": s,
                            "source_article_path": p,
                        }
                        for t, s, p in rows
                    ]
                )
            )

    async def count_incoming(self, target_topic_id: UUID) -> int:
        row = (
            await self.session.execute(
                select(BacklinkORM.target_topic_id)
                .where(BacklinkORM.target_topic_id == target_topic_id)
            )
        ).all()
        return len(row)

    async def get_incoming(self, target_topic_id: UUID) -> list[UUID]:
        rows = (
            await self.session.execute(
                select(BacklinkORM.source_topic_id).where(
                    BacklinkORM.target_topic_id == target_topic_id
                )
            )
        ).scalars().all()
        return list(rows)
