"""PipelineRun service + independent progress runner."""

from uuid import UUID

from sqlalchemy.ext.asyncio import async_sessionmaker

from great_minds.core.ingest_schemas import StagedFileInput
from great_minds.core.pagination import Page, PageParams, create_page
from great_minds.core.pipeline_runs.repository import PipelineRunRepository
from great_minds.core.pipeline_runs.schemas import (
    PipelinePhase,
    PipelinePhaseStatus,
    PipelineProgressStep,
    PipelineRun,
    PipelineRunCreate,
    PipelineRunFilter,
    PipelineRunUpdate,
    PipelineStepStatus,
    PipelineTaskType,
    PipelineTrigger,
)
from great_minds.core.tasks import TaskService


_PHASE_LABELS: dict[PipelinePhase, str] = {
    PipelinePhase.SOURCE_INGEST: "Processing uploaded sources",
    PipelinePhase.INGEST: "Indexing documents for search",
    PipelinePhase.EXTRACT: "Reading documents",
    PipelinePhase.ABSTRACT: "Synthesizing topics",
    PipelinePhase.DERIVE: "Mapping connections",
    PipelinePhase.RENDER: "Writing articles",
    PipelinePhase.VERIFY: "Checking references",
    PipelinePhase.PUBLISH: "Finalizing",
}

_STEP_STATUS_BY_PHASE_STATUS: dict[PipelinePhaseStatus, PipelineStepStatus] = {
    PipelinePhaseStatus.STARTED: PipelineStepStatus.RUNNING,
    PipelinePhaseStatus.PROGRESS: PipelineStepStatus.RUNNING,
    PipelinePhaseStatus.COMPLETED: PipelineStepStatus.COMPLETED,
    PipelinePhaseStatus.FAILED: PipelineStepStatus.FAILED,
}


def phase_step(
    *,
    phase: PipelinePhase,
    status: PipelinePhaseStatus,
    label: str | None = None,
    done: int | None = None,
    total: int | None = None,
    detail: str = "",
) -> PipelineProgressStep:
    return PipelineProgressStep(
        key="phase",
        label=label if label is not None else _PHASE_LABELS[phase],
        status=_STEP_STATUS_BY_PHASE_STATUS[status],
        done=done,
        total=total,
        detail=detail,
    )


class PipelineRunService:
    def __init__(self, repo: PipelineRunRepository, task_service: TaskService) -> None:
        self.repo = repo
        self.task_service = task_service

    async def create(self, data: PipelineRunCreate) -> PipelineRun:
        return await self.repo.create(data)

    async def get(self, pipeline_run_id: UUID, vault_id: UUID) -> PipelineRun | None:
        return await self.repo.get(pipeline_run_id, vault_id)

    async def cancel(self, pipeline_run_id: UUID, vault_id: UUID) -> None:
        # Commit the cancelled status (NOTIFY → UI) before the cooperative
        # task cancel, which lands at the task's next step boundary.
        active_task_id = await self.repo.cancel(
            pipeline_run_id, vault_id, "Update cancelled"
        )
        await self.commit()
        if active_task_id is not None:
            await self.task_service.cancel(active_task_id)

    async def list_for_vault(
        self,
        vault_id: UUID,
        *,
        status: PipelineRunFilter | None = None,
        pagination: PageParams,
    ) -> Page[PipelineRun]:
        items = await self.repo.list_for_vault(
            vault_id,
            status=status,
            limit=pagination.limit,
            offset=pagination.offset,
        )
        total = await self.repo.count_for_vault(vault_id, status=status)
        return create_page(items, pagination, total)

    async def attach_ingest_task(self, pipeline_run_id: UUID, task_id: UUID) -> None:
        await self.repo.attach_task(
            pipeline_run_id, task_id, PipelineTaskType.STAGED_FILE_INGEST
        )

    async def attach_compile_intent(
        self, pipeline_run_id: UUID, intent_id: UUID
    ) -> None:
        await self.repo.attach_compile_intent(pipeline_run_id, intent_id)

    async def update_progress(
        self,
        pipeline_run_id: UUID,
        data: PipelineRunUpdate,
    ) -> UUID | None:
        return await self.repo.update_progress(pipeline_run_id, data)

    async def start_staged_file_ingest(
        self,
        *,
        vault_id: UUID,
        job_id: UUID,
        files: list[StagedFileInput],
    ) -> PipelineRun:
        if not files:
            raise ValueError("no files provided")
        run = await self.create(
            PipelineRunCreate(
                id=job_id,
                vault_id=vault_id,
                trigger=PipelineTrigger.STAGED_FILES,
            )
        )
        detail = await self.task_service.spawn_staged_file_ingest(
            vault_id=vault_id,
            files=[f.model_dump() for f in files],
            pipeline_run_id=run.id,
        )
        await self.attach_ingest_task(run.id, detail.id)
        await self.commit()
        refreshed = await self.get(run.id, vault_id)
        if refreshed is None:
            raise RuntimeError(f"Pipeline run not found after creation: {run.id}")
        return refreshed

    async def commit(self) -> None:
        await self.repo.session.commit()


class PipelineProgressService:
    def __init__(self, repo: PipelineRunRepository) -> None:
        self.repo = repo

    async def fail(self, pipeline_run_id: UUID, error: str) -> UUID | None:
        # The pipeline_runs trigger emits the LISTEN/NOTIFY wakeup on commit.
        return await self.repo.fail(pipeline_run_id, error)

    async def emit(
        self,
        *,
        pipeline_run_id: UUID,
        phase: str,
        status: str,
        steps: list[PipelineProgressStep],
        error: str | None = None,
    ) -> UUID | None:
        return await self.repo.update_progress(
            pipeline_run_id,
            PipelineRunUpdate(
                phase=phase,
                status=status,
                progress_steps=steps,
                error=error,
            ),
        )


class PipelineProgressRunner:
    def __init__(self, session_maker: async_sessionmaker) -> None:
        self.session_maker = session_maker

    async def fail(self, pipeline_run_id: UUID, error: str) -> None:
        """Mark the current phase failed in a short independent transaction."""
        async with self.session_maker() as session:
            service = PipelineProgressService(PipelineRunRepository(session))
            vault_id = await service.fail(pipeline_run_id, error)
            if vault_id is None:
                await session.rollback()
                return
            await session.commit()

    async def emit(
        self,
        *,
        pipeline_run_id: UUID,
        phase: str,
        status: str,
        steps: list[PipelineProgressStep],
        error: str | None = None,
    ) -> None:
        """Persist progress in a short independent transaction."""
        async with self.session_maker() as session:
            service = PipelineProgressService(PipelineRunRepository(session))
            vault_id = await service.emit(
                pipeline_run_id=pipeline_run_id,
                phase=phase,
                status=status,
                steps=steps,
                error=error,
            )
            if vault_id is None:
                await session.rollback()
                return
            await session.commit()
