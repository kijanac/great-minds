"""Task service: spawn (for the reconciler), list, and fetch task status.

Direct callers should NOT spawn compiles — they write a CompileIntent
and let the reconciler dispatch. `spawn_compile_for_intent` is the
reconciler's entry point and uses `idempotency_key=str(intent_id)` so a
crash between spawn and `mark_dispatched` is safe to retry.
"""

from typing import Any, Literal, cast, get_args
from uuid import UUID

from absurd_sdk import AsyncAbsurd, RetryStrategy

from great_minds.core.pagination import Page, PageParams, create_page
from great_minds.core.tasks.repository import TaskRepository
from great_minds.core.tasks.schemas import Task, TaskDetail, TaskStatus
from great_minds.core.telemetry import log_event

COMPILE_RETRY: RetryStrategy = {
    "kind": "exponential",
    "base_seconds": 10.0,
    "factor": 2.0,
    "max_seconds": 300.0,
}

ActiveAbsurdState = Literal["pending", "running", "sleeping"]
_ACTIVE: tuple[str, ...] = get_args(ActiveAbsurdState)


async def fetch_task_response(absurd: AsyncAbsurd, task: Task) -> TaskDetail:
    """Build a TaskDetail by fetching current status from absurd.

    Detailed task results (compile telemetry, staged-file ingest counts) live
    in structured logs via `emit_wide_event` — they are not surfaced
    here. This response carries lifecycle state only.
    """
    snapshot = await absurd.fetch_task_result(str(task.id))

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
        id=task.id,
        type=task.type,
        status=status,
        created_at=task.created_at,
        error=error,
        params=task.params,
        pipeline_run_id=task.pipeline_run_id,
    )


class TaskService:
    def __init__(self, repo: TaskRepository, absurd: AsyncAbsurd) -> None:
        self.repo = repo
        self.absurd = absurd

    async def spawn_staged_file_ingest(
        self,
        *,
        vault_id: UUID,
        files: list[dict],
        pipeline_run_id: UUID | None = None,
    ) -> TaskDetail:
        """Spawn a staged-file ingest task that pulls from R2 ``staging/<vault>/<hash>``.

        Uses the pipeline run id as the Absurd idempotency key, so retrying
        the same /process call returns/reuses the same task. The worker is
        also idempotent at the document level via content-addressable dest
        paths + ``batch_upsert`` ON CONFLICT, so task retries are safe.
        Staged-file ingest always lands as ``source_type='document'``.
        """
        params: dict = {
            "vault_id": str(vault_id),
            "files": files,
            **({"pipeline_run_id": str(pipeline_run_id)} if pipeline_run_id else {}),
        }
        spawn_kwargs: dict[str, Any] = {"max_attempts": 2}
        if pipeline_run_id is not None:
            spawn_kwargs["idempotency_key"] = str(pipeline_run_id)
        result = await self.absurd.spawn(
            "staged_file_ingest",
            params,
            **spawn_kwargs,
        )
        record = await self.repo.create(
            cast(UUID, result["task_id"]),
            vault_id,
            "staged_file_ingest",
            params,
            pipeline_run_id=pipeline_run_id,
        )
        await self.repo.session.commit()
        log_event(
            "staged_file_ingest_spawned",
            task_id=str(record.id),
            vault_id=str(vault_id),
            file_count=len(files),
        )
        return await fetch_task_response(self.absurd, record)

    async def spawn_compile_for_intent(
        self,
        *,
        intent_id: UUID,
        vault_id: UUID,
        data_dir: str,
        label: str,
        pipeline_run_id: UUID | None = None,
    ) -> TaskDetail:
        """Spawn a compile task for a CompileIntent.

        `idempotency_key=str(intent_id)` makes this safe to call N times
        for the same intent — Absurd returns the same task each time.
        """
        params: dict[str, str] = {
            "vault_id": str(vault_id),
            "data_dir": data_dir,
            "label": label,
            **({"pipeline_run_id": str(pipeline_run_id)} if pipeline_run_id else {}),
        }
        result = await self.absurd.spawn(
            "compile",
            params,
            max_attempts=3,
            retry_strategy=COMPILE_RETRY,
            idempotency_key=str(intent_id),
        )
        # absurd_sdk's SpawnResult types task_id as str, but psycopg's
        # UUID adapter returns a uuid.UUID at runtime. Cast bridges the
        # type lie at zero runtime cost; if the SDK ever switches to
        # actually returning str, SQLAlchemy will surface the mismatch
        # at insert time.
        record = await self.repo.create(
            cast(UUID, result["task_id"]),
            vault_id,
            "compile",
            params,
            pipeline_run_id=pipeline_run_id,
        )
        await self.repo.session.commit()
        log_event(
            "compile_spawned",
            task_id=str(record.id),
            vault_id=str(vault_id),
            intent_id=str(intent_id),
        )
        return await fetch_task_response(self.absurd, record)

    async def find_active_compile(self, vault_id: UUID) -> TaskDetail | None:
        """Most recent compile task for this vault still in pending/running/sleeping."""
        records = await self.repo.list_for_vault(
            vault_id, task_type="compile", limit=10
        )
        for record in records:
            snapshot = await self.absurd.fetch_task_result(str(record.id))
            if snapshot is None:
                continue
            if snapshot.state in _ACTIVE:
                return await fetch_task_response(self.absurd, record)
        return None

    async def list_for_vault(
        self, vault_id: UUID, *, pagination: PageParams
    ) -> Page[TaskDetail]:
        records = await self.repo.list_for_vault(
            vault_id, limit=pagination.limit, offset=pagination.offset
        )
        total = await self.repo.count_for_vault(vault_id)
        items = [await fetch_task_response(self.absurd, r) for r in records]
        return create_page(items, pagination, total)

    async def get(self, task_id: UUID, vault_id: UUID) -> TaskDetail | None:
        record = await self.repo.get(task_id, vault_id)
        if record is None:
            return None
        return await fetch_task_response(self.absurd, record)

    async def cancel(self, task_id: UUID) -> None:
        """Cancel a queued/running Absurd task. Cooperative — takes effect at
        the task's next step boundary, so a long-running phase finishes before
        the task tears down."""
        await self.absurd.cancel_task(str(task_id))
