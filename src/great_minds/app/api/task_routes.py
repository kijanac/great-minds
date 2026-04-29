"""Task routes."""

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException

from great_minds.app.api.dependencies import (
    BrainMemberGuard,
    get_task_service,
    PageParamsQuery,
)
from great_minds.core.pagination import Page
from great_minds.core.tasks.schemas import TaskDetail
from great_minds.core.tasks.service import TaskService

router = APIRouter(prefix="/tasks", tags=["tasks"])


@router.get("")
async def list_tasks(
    brain_id: UUID,
    pagination: PageParamsQuery,
    _auth: BrainMemberGuard,
    task_service: TaskService = Depends(get_task_service),
) -> Page[TaskDetail]:
    result = await task_service.list_for_brain(brain_id, pagination=pagination)
    return result


@router.get("/{task_id}")
async def get_task(
    task_id: UUID,
    brain_id: UUID,
    _auth: BrainMemberGuard,
    task_service: TaskService = Depends(get_task_service),
) -> TaskDetail:
    response = await task_service.get(task_id, brain_id)
    if response is None:
        raise HTTPException(status_code=404, detail="Task not found")
    return response
