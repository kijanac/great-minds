"""Compile routes.

POST writes an internal CompileIntent attached to a job and returns
that user-visible job. The reconciler dispatches the intent to Absurd
within ~5s. CompileIntent remains an internal outbox detail.
"""

from uuid import UUID

from fastapi import APIRouter, HTTPException, status

from great_minds.app.api.dependencies import (
    CompileIntentRepositoryDep,
    LlmGuard,
    PipelineRunServiceDep,
)
from great_minds.app.api.schemas.jobs import JobResponse
from great_minds.app.api.schemas.tasks import CompileRequest
from great_minds.core.pipeline_runs import PipelineRunCreate, PipelineTrigger
from great_minds.core.telemetry import log_event

router = APIRouter(prefix="/compile", tags=["compile"])


@router.post("", status_code=status.HTTP_202_ACCEPTED)
async def request_compile(
    req: CompileRequest,
    vault_id: UUID,
    intent_repo: CompileIntentRepositoryDep,
    pipeline_service: PipelineRunServiceDep,
    _llm: LlmGuard,
) -> JobResponse:
    record = await intent_repo.upsert_pending(vault_id, pipeline_run_id=req.job_id)
    if record is None:
        record = await intent_repo.get_pending_for_vault(vault_id)
    if record is None:
        # Race: a reconciler dispatched between upsert and lookup. Caller
        # should refresh the active jobs list.
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Intent dispatched between request and lookup; refresh task list",
        )
    if record.pipeline_run_id is None:
        run = await pipeline_service.create(
            PipelineRunCreate(
                id=req.job_id,
                vault_id=vault_id,
                trigger=PipelineTrigger.MANUAL,
            )
        )
        await intent_repo.attach_pipeline_run(record.id, run.id)
        record.pipeline_run_id = run.id
        await pipeline_service.repo.attach_compile_intent(run.id, record.id)
    await intent_repo.session.commit()
    log_event(
        "intent_created",
        intent_id=str(record.id),
        vault_id=str(vault_id),
        trigger="api",
    )
    if record.pipeline_run_id is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Compile intent missing pipeline run after creation",
        )
    run = await pipeline_service.get(record.pipeline_run_id, vault_id)
    if run is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Compile pipeline run not found after creation",
        )
    return JobResponse.model_validate(run)
