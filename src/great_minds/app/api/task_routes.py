"""Task routes."""

from uuid import UUID

from fastapi import APIRouter, HTTPException

from great_minds.app.api.dependencies import (
    PageParamsQuery,
    TaskServiceDep,
)
from great_minds.core.pagination import Page
from great_minds.core.tasks.schemas import TaskDetail

router = APIRouter(prefix="/tasks", tags=["tasks"])


@router.get("")
async def list_tasks(
    vault_id: UUID,
    pagination: PageParamsQuery,
    task_service: TaskServiceDep,
) -> Page[TaskDetail]:
    result = await task_service.list_for_vault(vault_id, pagination=pagination)
    return result


@router.get("/{task_id}")
async def get_task(
    task_id: UUID,
    vault_id: UUID,
    task_service: TaskServiceDep,
) -> TaskDetail:
    response = await task_service.get(task_id, vault_id)
    if response is None:
        raise HTTPException(status_code=404, detail="Task not found")
    return response
