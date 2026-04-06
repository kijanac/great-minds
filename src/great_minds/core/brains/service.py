"""Brain service: instance creation, task management, and post-compilation hooks."""

import logging
from pathlib import Path
from typing import ClassVar
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.core.brains.models import Brain as BrainModel, BrainMembership, BrainType, MemberRole
from great_minds.core.brains.repository import get_brain_with_role, list_user_brains, upsert_membership
from great_minds.core.brains._compiler import CompilationResult
from great_minds.core.brains._linter import lint_links_to_slugs
from great_minds.core.db import async_session_from_settings
from great_minds.core.brain import Brain
from great_minds.core.querier import QuerySource
from great_minds.core.storage import LocalStorage
from great_minds.core.tasks import TaskManager

log = logging.getLogger(__name__)


class BrainService:
    """Manages Brain instances, task managers, and brain lifecycle operations."""

    _manager_cache: ClassVar[dict[str, TaskManager]] = {}

    async def get_brain(self, session: AsyncSession, brain_id: UUID, user_id: UUID) -> tuple[BrainModel, MemberRole]:
        """Fetch a brain by ID with access check. Raises ValueError if not found."""
        result = await get_brain_with_role(session, brain_id, user_id)
        if result is None:
            raise ValueError(f"Brain {brain_id} not found or not accessible")
        return result

    def build(self, brain: BrainModel) -> Brain:
        """Create a fresh Brain instance from a DB model."""
        return Brain(LocalStorage(Path(brain.storage_root)), label=brain.slug)

    async def get_all_query_sources(self, session: AsyncSession, user_id: UUID) -> list[QuerySource]:
        """Build QuerySources for all brains a user has access to."""
        rows = await list_user_brains(session, user_id)
        return [QuerySource(storage=LocalStorage(Path(brain.storage_root)), label=brain.slug) for brain, _role in rows]

    def get_task_manager(self, brain: BrainModel) -> TaskManager:
        if brain.storage_root not in self._manager_cache:
            on_done = self._make_post_compile_hook(brain) if brain.type == BrainType.TEAM else None
            self._manager_cache[brain.storage_root] = TaskManager(
                self.build(brain),
                on_compile_done=on_done,
            )
        return self._manager_cache[brain.storage_root]

    def get_article_count(self, brain: BrainModel) -> int:
        return len(self.build(brain).list_articles())

    async def create_team_brain(
        self,
        session: AsyncSession,
        name: str,
        owner_id: UUID,
    ) -> tuple[BrainModel, MemberRole]:
        """Create a team brain with the owner as first member."""
        slug = name.lower().replace(" ", "-")
        brain = BrainModel(
            name=name,
            slug=slug,
            owner_id=owner_id,
            type=BrainType.TEAM,
            storage_root=f"brains/{slug}",
        )
        session.add(brain)
        await session.flush()
        await upsert_membership(session, brain.id, owner_id, MemberRole.OWNER)
        return brain, MemberRole.OWNER

    def _make_post_compile_hook(self, team_brain: BrainModel):
        """Create a post-compilation hook for a team brain.

        After compilation, finds personal brains of team members and checks
        if any of their articles link to slugs that changed.
        """
        async def on_compile_done(brain: Brain, result: CompilationResult) -> None:
            changed_slugs = [a["slug"] for a in result.articles_written]
            if not changed_slugs:
                return

            log.info(
                "team brain %s compiled, checking %d changed slugs against member personal brains",
                brain.label, len(changed_slugs),
            )

            async with async_session_from_settings() as session:
                member_rows = await session.execute(
                    select(BrainModel)
                    .join(BrainMembership, BrainMembership.user_id.in_(
                        select(BrainMembership.user_id).where(BrainMembership.brain_id == team_brain.id)
                    ))
                    .where(BrainModel.type == BrainType.PERSONAL)
                    .distinct()
                )
                personal_brains = member_rows.scalars().all()

            instances = [self.build(row) for row in personal_brains]
            if not instances:
                return

            lint_result = lint_links_to_slugs(instances, changed_slugs, brain.storage)

            if lint_result.broken_links:
                log.warning(
                    "team brain %s compilation broke %d links in personal brains",
                    brain.label, len(lint_result.broken_links),
                )
                for bl in lint_result.broken_links:
                    log.warning("  %s: %s links to missing %s", bl.brain_label, bl.article, bl.target_slug)
            else:
                log.info("team brain %s compilation: no broken links in personal brains", brain.label)

        return on_compile_done
