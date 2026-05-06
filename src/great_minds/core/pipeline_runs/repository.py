"""PipelineRun repository."""

import json
from uuid import UUID

from sqlalchemy import case, func, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.core.pipeline_runs.models import PipelineRunRecord
from great_minds.core.pipeline_runs.schemas import PipelineRun, PipelineRunStatus

CHANNEL = "pipeline_progress"

_ACTIVE = (PipelineRunStatus.PENDING.value, PipelineRunStatus.RUNNING.value)


class PipelineRunRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def create(self, *, vault_id: UUID, trigger: str) -> PipelineRun:
        row = await self.session.execute(
            insert(PipelineRunRecord)
            .values(
                vault_id=vault_id,
                trigger=trigger,
                status=PipelineRunStatus.PENDING.value,
            )
            .returning(PipelineRunRecord)
        )
        record = row.scalar_one()
        return PipelineRun.model_validate(record)

    async def get(self, pipeline_run_id: UUID, vault_id: UUID) -> PipelineRun | None:
        row = await self.session.execute(
            select(PipelineRunRecord)
            .where(
                PipelineRunRecord.id == pipeline_run_id,
                PipelineRunRecord.vault_id == vault_id,
            )
            .execution_options(populate_existing=True)
        )
        record = row.scalar_one_or_none()
        return PipelineRun.model_validate(record) if record else None

    async def get_current_for_vault(self, vault_id: UUID) -> PipelineRun | None:
        """Return newest active pipeline, falling back to newest pipeline."""
        active_rank = case((PipelineRunRecord.status.in_(_ACTIVE), 0), else_=1)
        row = await self.session.execute(
            select(PipelineRunRecord)
            .where(PipelineRunRecord.vault_id == vault_id)
            .order_by(active_rank, PipelineRunRecord.created_at.desc())
            .limit(1)
            .execution_options(populate_existing=True)
        )
        record = row.scalar_one_or_none()
        return PipelineRun.model_validate(record) if record else None

    async def attach_bulk_task(self, pipeline_run_id: UUID, task_id: UUID) -> None:
        await self.session.execute(
            update(PipelineRunRecord)
            .where(PipelineRunRecord.id == pipeline_run_id)
            .values(bulk_task_id=task_id, updated_at=func.now())
        )

    async def attach_compile_intent(
        self, pipeline_run_id: UUID, intent_id: UUID
    ) -> None:
        await self.session.execute(
            update(PipelineRunRecord)
            .where(PipelineRunRecord.id == pipeline_run_id)
            .values(compile_intent_id=intent_id, updated_at=func.now())
        )

    async def attach_compile_task(self, pipeline_run_id: UUID, task_id: UUID) -> None:
        await self.session.execute(
            update(PipelineRunRecord)
            .where(PipelineRunRecord.id == pipeline_run_id)
            .values(compile_task_id=task_id, updated_at=func.now())
        )

    async def fail(self, pipeline_run_id: UUID, error: str) -> UUID | None:
        row = await self.session.execute(
            update(PipelineRunRecord)
            .where(PipelineRunRecord.id == pipeline_run_id)
            .values(
                status=PipelineRunStatus.FAILED.value,
                phase_status="failed",
                error=error,
                completed_at=func.now(),
                updated_at=func.now(),
            )
            .returning(PipelineRunRecord.vault_id)
        )
        return row.scalar_one_or_none()

    async def update_progress(
        self,
        pipeline_run_id: UUID,
        *,
        phase: str,
        status: str,
        done: int | None = None,
        total: int | None = None,
        failed: int | None = None,
        message: str = "",
        error: str | None = None,
    ) -> UUID | None:
        values: dict[str, object] = {
            "status": PipelineRunStatus.RUNNING.value,
            "current_phase": phase,
            "phase_status": status,
            "progress_message": message,
            "updated_at": func.now(),
        }
        if done is not None:
            values["progress_done"] = done
        if total is not None:
            values["progress_total"] = total
        if failed is not None:
            values["progress_failed"] = failed
        if error is not None or status == "failed":
            values["error"] = error or "Pipeline failed"
            values["status"] = PipelineRunStatus.FAILED.value
            values["completed_at"] = func.now()
        elif phase == "publish" and status == "completed":
            values["status"] = PipelineRunStatus.COMPLETED.value
            values["completed_at"] = func.now()

        row = await self.session.execute(
            update(PipelineRunRecord)
            .where(PipelineRunRecord.id == pipeline_run_id)
            .values(**values)
            .returning(PipelineRunRecord.vault_id)
        )
        return row.scalar_one_or_none()

    async def notify_changed(self, *, pipeline_run_id: UUID, vault_id: UUID) -> None:
        payload = {
            "pipeline_run_id": str(pipeline_run_id),
            "vault_id": str(vault_id),
        }
        await self.session.execute(select(func.pg_notify(CHANNEL, json.dumps(payload))))
