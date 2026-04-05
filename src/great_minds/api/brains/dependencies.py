"""Brain resolution FastAPI dependency."""

from uuid import UUID

from fastapi import Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.api.auth.dependencies import get_current_user
from great_minds.api.auth.models import User
from great_minds.api.brains.models import Brain as BrainModel
from great_minds.api.brains.repository import get_brain_with_role, get_personal_brain, list_user_brains
from great_minds.api.brains.service import get_brain_instance, get_task_manager
from great_minds.api.db import get_session
from great_minds.core.brain import Brain
from great_minds.core.tasks import TaskManager


class ResolvedBrain:
    def __init__(self, instance: Brain, row: BrainModel, manager: TaskManager, all_brains: list[Brain]):
        self.instance = instance
        self.row = row
        self.manager = manager
        self.all_brains = all_brains


async def resolve_brain(
    brain: UUID | None = Query(None, description="Brain ID. Defaults to personal brain."),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> ResolvedBrain:
    if brain is None:
        brain_row = await get_personal_brain(session, user.id)
        if brain_row is None:
            raise HTTPException(status_code=404, detail="No personal brain found")
    else:
        result = await get_brain_with_role(session, brain, user.id)
        if result is None:
            raise HTTPException(status_code=404, detail="Brain not found")
        brain_row = result[0]

    instance = get_brain_instance(brain_row)

    # Build brain list: targeted brain first, then all others the user has access to
    all_brains = [instance]
    user_brains = await list_user_brains(session, user.id)
    for other_row, _role in user_brains:
        if other_row.id != brain_row.id:
            all_brains.append(get_brain_instance(other_row))

    return ResolvedBrain(
        instance=instance,
        row=brain_row,
        manager=get_task_manager(brain_row),
        all_brains=all_brains,
    )
