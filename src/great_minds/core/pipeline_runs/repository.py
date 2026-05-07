"""PipelineRun repository."""

from datetime import datetime
from uuid import UUID

from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.core.pipeline_runs.models import PipelineRunRecord
from great_minds.core.pipeline_runs.schemas import (
    PipelineRun,
    PipelineRunCreate,
    PipelineRunStatus,
)

CHANNEL = "pipeline_progress"

_ACTIVE = (PipelineRunStatus.PENDING.value, PipelineRunStatus.RUNNING.value)


class PipelineRunRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def create(self, data: PipelineRunCreate) -> PipelineRun:
        row = await self.session.execute(
            insert(PipelineRunRecord)
            .values(**data.model_dump())
            .on_conflict_do_nothing(index_elements=["id"])
            .returning(PipelineRunRecord)
        )
        record = row.scalar_one_or_none()
        if record is None:
            existing = await self.session.get(PipelineRunRecord, data.id)
            if existing is None:
                raise RuntimeError(f"PipelineRunRecord {data.id} missing after upsert")
            record = existing
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

    async def list_for_vault(
        self,
        vault_id: UUID,
        *,
        status: str | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> list[PipelineRun]:
        stmt = select(PipelineRunRecord).where(PipelineRunRecord.vault_id == vault_id)
        if status == "active":
            stmt = stmt.where(PipelineRunRecord.status.in_(_ACTIVE))
        elif status is not None:
            stmt = stmt.where(PipelineRunRecord.status == status)
        stmt = (
            stmt.order_by(PipelineRunRecord.created_at.desc())
            .offset(offset)
            .limit(limit)
        )
        row = await self.session.execute(stmt.execution_options(populate_existing=True))
        return [PipelineRun.model_validate(r) for r in row.scalars().all()]

    async def count_for_vault(
        self, vault_id: UUID, *, status: str | None = None
    ) -> int:
        stmt = select(func.count()).where(PipelineRunRecord.vault_id == vault_id)
        if status == "active":
            stmt = stmt.where(PipelineRunRecord.status.in_(_ACTIVE))
        elif status is not None:
            stmt = stmt.where(PipelineRunRecord.status == status)
        return (await self.session.scalar(stmt)) or 0

    async def list_stale_active(self, older_than: datetime) -> list[PipelineRun]:
        """Return active pipeline runs that haven't been updated since `older_than`."""
        row = await self.session.execute(
            select(PipelineRunRecord)
            .where(
                PipelineRunRecord.status.in_(_ACTIVE),
                PipelineRunRecord.updated_at < older_than,
            )
            .execution_options(populate_existing=True)
        )
        return [PipelineRun.model_validate(r) for r in row.scalars().all()]

    async def attach_ingest_task(self, pipeline_run_id: UUID, task_id: UUID) -> None:
        await self.session.execute(
            update(PipelineRunRecord)
            .where(PipelineRunRecord.id == pipeline_run_id)
            .values(ingest_task_id=task_id, updated_at=func.now())
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
