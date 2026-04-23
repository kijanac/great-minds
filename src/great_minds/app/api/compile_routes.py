"""Compile routes."""

from uuid import UUID

from fastapi import APIRouter, Depends

from great_minds.app.api.dependencies import (
    get_brain_service,
    get_task_service,
    require_brain_member,
    require_llm,
)
from great_minds.app.api.schemas.tasks import CompileRequest
from great_minds.core.brains.service import BrainService
from great_minds.core.settings import Settings, get_settings
from great_minds.core.tasks.schemas import TaskDetail
from great_minds.core.tasks.service import TaskService

router = APIRouter(prefix="/compile", tags=["compile"])


@router.post("")
async def compile(
    req: CompileRequest,
    brain_id: UUID,
    settings: Settings = Depends(get_settings),
    task_service: TaskService = Depends(get_task_service),
    brain_service: BrainService = Depends(get_brain_service),
    _auth: None = Depends(require_brain_member),
    _llm: None = Depends(require_llm),
) -> TaskDetail:
    del req  # reserved for future compile options
    brain = await brain_service.get_by_id(brain_id)
    return await task_service.spawn_compile(
        brain_id=brain_id,
        data_dir=settings.data_dir,
        label=brain.name,
    )
