"""Compile intent application service."""

from uuid import UUID

from great_minds.core.compile_intents.repository import CompileIntentRepository
from great_minds.core.pipeline_runs import (
    PipelineRun,
    PipelineRunCreate,
    PipelineRunService,
    PipelineTrigger,
)
from great_minds.core.telemetry import log_event


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
        """Queue a compile intent and return its user-visible pipeline run.

        Returns ``None`` only for the narrow race where a reconciler dispatches
        the pending intent between insert and lookup; callers can surface that
        as a refresh/retry conflict.
        """
        record = await self.intent_repo.upsert_pending(vault_id, pipeline_run_id=job_id)
        if record is None:
            record = await self.intent_repo.get_pending_for_vault(vault_id)
        if record is None:
            return None

        if record.pipeline_run_id is None:
            run = await self.pipeline_service.create(
                PipelineRunCreate(
                    id=job_id,
                    vault_id=vault_id,
                    trigger=PipelineTrigger.MANUAL,
                )
            )
            await self.intent_repo.attach_pipeline_run(record.id, run.id)
            record.pipeline_run_id = run.id
            await self.pipeline_service.attach_compile_intent(run.id, record.id)

        await self.intent_repo.session.commit()
        log_event(
            "intent_created",
            intent_id=str(record.id),
            vault_id=str(vault_id),
            trigger="api",
        )

        if record.pipeline_run_id is None:
            raise RuntimeError("Compile intent missing pipeline run after creation")
        return await self.pipeline_service.get(record.pipeline_run_id, vault_id)
