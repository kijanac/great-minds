"""Task service: spawn (for the reconciler), list, and fetch task status.

Direct callers should NOT spawn compiles — they write a CompileIntent
and let the reconciler dispatch. `spawn_compile_for_intent` is the
reconciler's entry point and uses `idempotency_key=str(intent_id)` so a
crash between spawn and `mark_dispatched` is safe to retry.
"""

import logging
from typing import Literal, get_args
from uuid import UUID

from absurd_sdk import AsyncAbsurd, RetryStrategy

from great_minds.core.tasks.models import TaskRecord
from great_minds.core.tasks.repository import TaskRepository
from great_minds.core.tasks.schemas import TaskDetail, TaskStatus

log = logging.getLogger(__name__)

COMPILE_RETRY: RetryStrategy = {
    "kind": "exponential",
    "base_seconds": 10.0,
    "factor": 2.0,
    "max_seconds": 300.0,
}

ActiveAbsurdState = Literal["pending", "running", "sleeping"]
_ACTIVE: tuple[str, ...] = get_args(ActiveAbsurdState)


async def fetch_task_response(absurd: AsyncAbsurd, record: TaskRecord) -> TaskDetail:
    """Build a TaskDetail by fetching current status from absurd.

    Detailed task results (compile telemetry, bulk-ingest counts) live
    in structured logs via `emit_wide_event` — they are not surfaced
    here. This response carries lifecycle state only.
    """
    snapshot = await absurd.fetch_task_result(str(record.id))

    status = TaskStatus.PENDING
    error = None

    if snapshot is not None:
        if snapshot.state == "completed":
            status = TaskStatus.COMPLETED
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
    )


class TaskService:
    def __init__(self, repo: TaskRepository, absurd: AsyncAbsurd) -> None:
        self.repo = repo
        self.absurd = absurd

    async def spawn_compile_for_intent(
        self,
        *,
        intent_id: UUID,
        brain_id: UUID,
        data_dir: str,
        label: str,
    ) -> TaskDetail:
        """Spawn a compile task for a CompileIntent.

        `idempotency_key=str(intent_id)` makes this safe to call N times
        for the same intent — Absurd returns the same task each time.
        """
        params: dict[str, str] = {
            "brain_id": str(brain_id),
            "data_dir": data_dir,
            "label": label,
        }
        result = await self.absurd.spawn(
            "compile",
            params,
            max_attempts=3,
            retry_strategy=COMPILE_RETRY,
            idempotency_key=str(intent_id),
        )
        record = await self.repo.create(
            UUID(result["task_id"]), brain_id, "compile", params
        )
        await self.repo.session.commit()
        log.info(
            "compile_spawned task_id=%s brain_id=%s intent_id=%s",
            record.id,
            brain_id,
            intent_id,
        )
        return await fetch_task_response(self.absurd, record)

    async def find_active_compile(self, brain_id: UUID) -> TaskDetail | None:
        """Most recent compile task for this brain still in pending/running/sleeping."""
        records = await self.repo.list_for_brain_by_type(brain_id, "compile")
        for record in records:
            snapshot = await self.absurd.fetch_task_result(str(record.id))
            if snapshot is None:
                continue
            if snapshot.state in _ACTIVE:
                return await fetch_task_response(self.absurd, record)
        return None

    async def list_for_brain(self, brain_id: UUID) -> list[TaskDetail]:
        records = await self.repo.list_for_brain(brain_id)
        return [await fetch_task_response(self.absurd, r) for r in records]

    async def get(self, task_id: UUID, brain_id: UUID) -> TaskDetail | None:
        record = await self.repo.get(task_id, brain_id)
        if record is None:
            return None
        return await fetch_task_response(self.absurd, record)
