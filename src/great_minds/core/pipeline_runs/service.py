"""PipelineRun service + independent progress runner."""

from uuid import UUID

from sqlalchemy.ext.asyncio import async_sessionmaker

from great_minds.core.ingest_schemas import StagedFileInput
from great_minds.core.pagination import Page, PageParams, create_page
from great_minds.core.pipeline_runs.repository import PipelineRunRepository
from great_minds.core.pipeline_runs.schemas import (
    PipelineProgress,
    PipelineRun,
    PipelineRunCreate,
    PipelineRunUpdate,
    PipelineTaskType,
    PipelineTrigger,
)
from great_minds.core.tasks import TaskService


class PipelineRunService:
    def __init__(self, repo: PipelineRunRepository, task_service: TaskService) -> None:
        self.repo = repo
        self.task_service = task_service

    async def create(self, data: PipelineRunCreate) -> PipelineRun:
        return await self.repo.create(data)

    async def get(self, pipeline_run_id: UUID, vault_id: UUID) -> PipelineRun | None:
        return await self.repo.get(pipeline_run_id, vault_id)

    async def list_for_vault(
        self,
        vault_id: UUID,
        *,
        status: str | None = None,
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
        content_type: str,
        source_type: str,
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
            content_type=content_type,
            source_type=source_type,
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
        done: int | None = None,
        total: int | None = None,
        failed: int | None = None,
        message: str = "",
        error: str | None = None,
    ) -> UUID | None:
        progress = None
        if done is not None or total is not None or failed is not None:
            progress = PipelineProgress(
                done=done or 0,
                total=total or 0,
                failed_items=failed or 0,
            )
        return await self.repo.update_progress(
            pipeline_run_id,
            PipelineRunUpdate(
                phase=phase,
                status=status,
                progress=progress,
                message=message,
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
        done: int | None = None,
        total: int | None = None,
        failed: int | None = None,
        message: str = "",
        error: str | None = None,
    ) -> None:
        """Persist progress in a short independent transaction."""
        async with self.session_maker() as session:
            service = PipelineProgressService(PipelineRunRepository(session))
            vault_id = await service.emit(
                pipeline_run_id=pipeline_run_id,
                phase=phase,
                status=status,
                done=done,
                total=total,
                failed=failed,
                message=message,
                error=error,
            )
            if vault_id is None:
                await session.rollback()
                return
            await session.commit()
