"""PipelineRun service + independent progress runner."""

from uuid import UUID

from sqlalchemy.ext.asyncio import async_sessionmaker

from great_minds.core.pagination import Page, PageInfo, PageParams
from great_minds.core.pipeline_runs.repository import PipelineRunRepository
from great_minds.core.pipeline_runs.schemas import PipelineRun, PipelineRunCreate


class PipelineRunService:
    def __init__(self, repo: PipelineRunRepository) -> None:
        self.repo = repo

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
        return Page(
            items=items,
            pagination=PageInfo(
                limit=pagination.limit,
                offset=pagination.offset,
                total=total,
            ),
        )


class PipelineProgressService:
    def __init__(self, repo: PipelineRunRepository) -> None:
        self.repo = repo

    async def fail(self, pipeline_run_id: UUID, error: str) -> UUID | None:
        vault_id = await self.repo.fail(pipeline_run_id, error)
        if vault_id is None:
            return None
        await self.repo.notify_changed(
            pipeline_run_id=pipeline_run_id,
            vault_id=vault_id,
        )
        return vault_id

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
        vault_id = await self.repo.update_progress(
            pipeline_run_id,
            phase=phase,
            status=status,
            done=done,
            total=total,
            failed=failed,
            message=message,
            error=error,
        )
        if vault_id is None:
            return None
        await self.repo.notify_changed(
            pipeline_run_id=pipeline_run_id,
            vault_id=vault_id,
        )
        return vault_id


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
