"""Task service: spawn, list, and fetch task status."""

import logging
from uuid import UUID, uuid4

from absurd_sdk import AsyncAbsurd
from sqlalchemy import text

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

# Absurd task states that count as "still in flight" for our dedup purposes.
ACTIVE_STATES = {"pending", "running", "sleeping"}


def _brain_lock_key(brain_id: UUID) -> int:
    """Stable signed int64 derived from the UUID's first 8 bytes.

    Used with pg_advisory_xact_lock to serialize compile-spawn decisions
    for a single brain across concurrent requests.
    """
    return int.from_bytes(brain_id.bytes[:8], "big", signed=True)


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
        data_dir: str,
        label: str,
        *,
        limit: int | None = None,
    ) -> TaskDetail:
        """Spawn a compile task for this brain, at most one in flight.

        Takes a per-brain advisory lock, checks for an existing active compile,
        and if one is found returns it without spawning. Otherwise spawns a new
        compile with a fresh uuid-based idempotency key.
        """
        await self.repo.session.execute(
            text("SELECT pg_advisory_xact_lock(:k)"),
            {"k": _brain_lock_key(brain_id)},
        )

        existing = await self._find_active_compile(brain_id)
        if existing is not None:
            log.info(
                "compile already active for brain=%s task_id=%s — skipping spawn",
                brain_id,
                existing.id,
            )
            return existing

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
            idempotency_key=f"compile:{brain_id}:{uuid4()}",
        )

    async def _find_active_compile(self, brain_id: UUID) -> TaskDetail | None:
        """Return the most recent compile task still in pending/running/sleeping."""
        records = await self.repo.list_for_brain_by_type(brain_id, "compile")
        for record in records:
            snapshot = await self.absurd.fetch_task_result(record.id)
            if snapshot is None:
                continue
            if snapshot.state in ACTIVE_STATES:
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
