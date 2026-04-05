"""Brain service: instance caching, resolution, and post-compilation hooks."""

import logging
from pathlib import Path

from sqlalchemy import select

from great_minds.api.brains.models import Brain as BrainModel, BrainType
from great_minds.core.brain import Brain
from great_minds.core.compiler import CompilationResult
from great_minds.core.linter import lint_links_to_slugs
from great_minds.core.storage import LocalStorage
from great_minds.core.tasks import TaskManager

log = logging.getLogger(__name__)

_brain_cache: dict[str, Brain] = {}
_manager_cache: dict[str, TaskManager] = {}


def get_brain_instance(brain_row: BrainModel) -> Brain:
    if brain_row.storage_root not in _brain_cache:
        _brain_cache[brain_row.storage_root] = Brain(
            LocalStorage(Path(brain_row.storage_root)),
            label=brain_row.slug,
        )
    return _brain_cache[brain_row.storage_root]


def get_task_manager(brain_row: BrainModel) -> TaskManager:
    if brain_row.storage_root not in _manager_cache:
        on_done = _make_post_compile_hook(brain_row) if brain_row.type == BrainType.TEAM else None
        _manager_cache[brain_row.storage_root] = TaskManager(
            get_brain_instance(brain_row),
            on_compile_done=on_done,
        )
    return _manager_cache[brain_row.storage_root]


def _make_post_compile_hook(team_brain_row: BrainModel):
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

        from great_minds.api.db import async_session_from_settings
        from great_minds.api.brains.models import BrainMembership

        async with async_session_from_settings() as session:
            # Find personal brains of all team members
            member_rows = await session.execute(
                select(BrainModel)
                .join(BrainMembership, BrainMembership.user_id.in_(
                    select(BrainMembership.user_id).where(BrainMembership.brain_id == team_brain_row.id)
                ))
                .where(BrainModel.type == BrainType.PERSONAL)
                .distinct()
            )
            personal_brain_rows = member_rows.scalars().all()

        personal_brains = [get_brain_instance(row) for row in personal_brain_rows]
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
