import asyncio
import os
from uuid import UUID

from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from great_minds.core.pipeline_runs.repository import PipelineRunRepository
from great_minds.core.pipeline_runs.schemas import (
    PipelinePhase,
    PipelinePhaseStatus,
    PipelineRunUpdate,
)


FAILED_RESURRECTION = UUID("00000000-0000-4000-8000-000000001403")
CANCELLED_RESURRECTION = UUID("00000000-0000-4000-8000-000000001404")
CANCELLED_CLOBBER = UUID("00000000-0000-4000-8000-000000001405")


async def main() -> None:
    database_url = os.environ["DATABASE_URL"].replace(
        "postgresql://", "postgresql+asyncpg://", 1
    )
    engine = create_async_engine(database_url)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with sessions() as session:
            repo = PipelineRunRepository(session)
            progress = PipelineRunUpdate(
                phase=PipelinePhase.INGEST,
                status=PipelinePhaseStatus.PROGRESS,
                progress_steps=[],
            )
            await repo.update_progress(FAILED_RESURRECTION, progress)
            await repo.update_progress(CANCELLED_RESURRECTION, progress)
            await repo.fail(CANCELLED_CLOBBER, "late failure")
            await session.commit()
    finally:
        await engine.dispose()


asyncio.run(main())
