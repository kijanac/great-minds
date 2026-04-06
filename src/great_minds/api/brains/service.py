"""Brain service: instance caching, resolution, and post-compilation hooks."""

import logging
from pathlib import Path
from typing import ClassVar
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.api.brains.models import Brain as BrainModel, BrainMembership, BrainType, MemberRole
from great_minds.api.brains.repository import upsert_membership
from great_minds.api.db import async_session_from_settings
from great_minds.core.brain import Brain
from great_minds.core.compiler import CompilationResult
from great_minds.core.linter import lint_links_to_slugs
from great_minds.core.storage import LocalStorage
from great_minds.core.tasks import TaskManager

log = logging.getLogger(__name__)


class BrainService:
    """Manages Brain instances, task managers, and brain lifecycle operations.

    Brain instances are created fresh per request. TaskManagers are cached
    at the class level because they hold in-flight task state.
    """

    _manager_cache: ClassVar[dict[str, TaskManager]] = {}

    def get_instance(self, brain_row: BrainModel) -> Brain:
        return Brain(LocalStorage(Path(brain_row.storage_root)), label=brain_row.slug)

    def get_task_manager(self, brain_row: BrainModel) -> TaskManager:
        if brain_row.storage_root not in self._manager_cache:
            on_done = self._make_post_compile_hook(brain_row) if brain_row.type == BrainType.TEAM else None
            self._manager_cache[brain_row.storage_root] = TaskManager(
                self.get_instance(brain_row),
                on_compile_done=on_done,
            )
        return self._manager_cache[brain_row.storage_root]

    def get_article_count(self, brain_row: BrainModel) -> int:
        return len(self.get_instance(brain_row).list_articles())

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

    def _make_post_compile_hook(self, team_brain_row: BrainModel):
        """Create a post-compilation hook for a team brain.

        After compilation, finds personal brains of team members and checks
        if any of their articles link to slugs that changed.
        """
        async def on_compile_done(team_brain: Brain, result: CompilationResult) -> None:
            changed_slugs = [a["slug"] for a in result.articles_written]
            if not changed_slugs:
                return

            log.info(
                "team brain %s compiled, checking %d changed slugs against member personal brains",
                team_brain.label, len(changed_slugs),
            )

            async with async_session_from_settings() as session:
                member_rows = await session.execute(
                    select(BrainModel)
                    .join(BrainMembership, BrainMembership.user_id.in_(
                        select(BrainMembership.user_id).where(BrainMembership.brain_id == team_brain_row.id)
                    ))
                    .where(BrainModel.type == BrainType.PERSONAL)
                    .distinct()
                )
                personal_brain_rows = member_rows.scalars().all()

            personal_brains = [self.get_instance(row) for row in personal_brain_rows]
            if not personal_brains:
                return

            lint_result = lint_links_to_slugs(personal_brains, changed_slugs, team_brain.storage)

            if lint_result.broken_links:
                log.warning(
                    "team brain %s compilation broke %d links in personal brains",
                    team_brain.label, len(lint_result.broken_links),
                )
                for bl in lint_result.broken_links:
                    log.warning("  %s: %s links to missing %s", bl.brain_label, bl.article, bl.target_slug)
            else:
                log.info("team brain %s compilation: no broken links in personal brains", team_brain.label)

        return on_compile_done
