"""Compile intent application service."""

from uuid import UUID

from great_minds.core.compile_intents.repository import CompileIntentRepository
from great_minds.core.pipeline_runs import (
    PipelineRun,
    PipelineRunCreate,
    PipelineRunService,
    PipelineTrigger,
)


class CompileIntentService:
    """Orchestrates user compile requests behind the API boundary."""

    def __init__(
        self,
        intent_repo: CompileIntentRepository,
        pipeline_service: PipelineRunService,
    ) -> None:
        self.intent_repo = intent_repo
        self.pipeline_service = pipeline_service

    async def request_compile(
        self, *, vault_id: UUID, job_id: UUID
    ) -> PipelineRun | None:
        """Queue a compile intent and return its user-visible pipeline run."""
        intent = await self.intent_repo.ensure_pending(vault_id, pipeline_run_id=job_id)
        pipeline_run_id = intent.pipeline_run_id
        if pipeline_run_id is None:
            run = await self.pipeline_service.create(
                PipelineRunCreate(
                    id=job_id,
                    vault_id=vault_id,
                    trigger=PipelineTrigger.MANUAL,
                )
            )
            pipeline_run_id = run.id
            await self.intent_repo.attach_pipeline_run(intent.id, pipeline_run_id)
            await self.pipeline_service.attach_compile_intent(
                pipeline_run_id, intent.id
            )
        await self.intent_repo.session.commit()
        return await self.pipeline_service.get(pipeline_run_id, vault_id)
