"""Task service: spawn, list, and fetch task status."""

import logging
from uuid import UUID

from absurd_sdk import AsyncAbsurd

from great_minds.core.compiler import compile_idempotency_key
from great_minds.core.storage import Storage
from great_minds.core.tasks.schemas import TaskDetail, TaskStatus
from great_minds.core.tasks.models import TaskRecord
from great_minds.core.tasks.repository import TaskRepository

log = logging.getLogger(__name__)

COMPILE_RETRY = {
    "kind": "exponential",
    "base_seconds": 10,
    "factor": 2,
    "max_seconds": 300,
}


async def fetch_task_response(absurd: AsyncAbsurd, record: TaskRecord) -> TaskDetail:
    """Build a TaskDetail by fetching current status from absurd."""
    snapshot = await absurd.fetch_task_result(record.id)

    status = TaskStatus.PENDING
    error = None
    result = {}

    if snapshot is not None:
        if snapshot.state == "completed":
            status = TaskStatus.COMPLETED
            result = snapshot.result or {}
        elif snapshot.state == "failed":
            status = TaskStatus.FAILED
            error = str(snapshot.failure) if snapshot.failure else "unknown error"
        elif snapshot.state == "cancelled":
            status = TaskStatus.CANCELLED
        else:
            status = TaskStatus.RUNNING

    return TaskDetail(
        id=record.id,
        type=record.type,
        status=status,
        created_at=record.created_at,
        error=error,
        params=record.params,
        result=result,
    )


class TaskService:
    def __init__(self, repo: TaskRepository, absurd: AsyncAbsurd) -> None:
        self.repo = repo
        self.absurd = absurd

    async def _commit(self) -> None:
        await self.repo.session.commit()

    async def _spawn(
        self,
        task_type: str,
        brain_id: UUID,
        params: dict,
        *,
        max_attempts: int,
        retry_strategy: dict,
        idempotency_key: str,
    ) -> TaskDetail:
        result = await self.absurd.spawn(
            task_type,
            params,
            max_attempts=max_attempts,
            retry_strategy=retry_strategy,
            idempotency_key=idempotency_key,
        )
        record = await self.repo.create(result["task_id"], brain_id, task_type, params)
        await self._commit()
        log.info(
            "task_spawned task_id=%s type=%s brain_id=%s",
            record.id,
            task_type,
            brain_id,
        )
        return await fetch_task_response(self.absurd, record)

    async def spawn_compile(
        self,
        brain_id: UUID,
        storage: Storage,
        data_dir: str,
        label: str,
        *,
        limit: int | None = None,
    ) -> TaskDetail:
        return await self._spawn(
            "compile",
            brain_id,
            {
                "brain_id": str(brain_id),
                "data_dir": data_dir,
                "label": label,
                "limit": limit,
            },
            max_attempts=3,
            retry_strategy=COMPILE_RETRY,
            idempotency_key=compile_idempotency_key(brain_id, storage),
        )

    async def list_for_brain(self, brain_id: UUID) -> list[TaskDetail]:
        records = await self.repo.list_for_brain(brain_id)
        return [await fetch_task_response(self.absurd, r) for r in records]

    async def get(self, task_id: UUID, brain_id: UUID) -> TaskDetail | None:
        record = await self.repo.get(task_id, brain_id)
        if record is None:
            return None
        return await fetch_task_response(self.absurd, record)
