"""Task routes."""

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException

from great_minds.app.api.dependencies import get_task_service, require_brain_member
from great_minds.core.tasks.schemas import TaskDetail
from great_minds.core.tasks.service import TaskService

router = APIRouter(prefix="/tasks", tags=["tasks"])


@router.get("")
async def list_tasks(
    brain_id: UUID,
    task_service: TaskService = Depends(get_task_service),
    _auth: None = Depends(require_brain_member),
) -> list[TaskDetail]:
    return await task_service.list_for_brain(brain_id)


@router.get("/{task_id}")
async def get_task(
    task_id: UUID,
    brain_id: UUID,
    task_service: TaskService = Depends(get_task_service),
    _auth: None = Depends(require_brain_member),
) -> TaskDetail:
    response = await task_service.get(task_id, brain_id)
    if response is None:
        raise HTTPException(status_code=404, detail="Task not found")
    return response
