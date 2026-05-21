"""Compile routes.

POST writes an internal CompileIntent attached to a job and returns
that user-visible job. The reconciler dispatches the intent to Absurd
within ~5s. CompileIntent remains an internal outbox detail.
"""

from uuid import UUID

from fastapi import APIRouter, status

from great_minds.app.api.dependencies import (
    CompileIntentServiceDep,
    LlmGuard,
    PipelineRunServiceDep,
)
from great_minds.app.api.schemas.jobs import JobResponse
from great_minds.app.api.schemas.tasks import CompileRequest

router = APIRouter(prefix="/compile", tags=["compile"])


@router.post("", status_code=status.HTTP_202_ACCEPTED)
async def request_compile(
    req: CompileRequest,
    vault_id: UUID,
    compile_service: CompileIntentServiceDep,
    _llm: LlmGuard,
) -> JobResponse:
    run = await compile_service.request_compile(vault_id=vault_id, job_id=req.job_id)
    if run is None:
        raise RuntimeError(
            f"compile pipeline run missing for vault {vault_id}, job {req.job_id}"
        )
    return JobResponse.model_validate(run)


@router.post("/{run_id}/cancel", status_code=status.HTTP_204_NO_CONTENT)
async def cancel_compile(
    run_id: UUID,
    vault_id: UUID,
    pipeline_service: PipelineRunServiceDep,
) -> None:
    # Idempotent: cancelling an already-finished run is a no-op. The UI learns
    # the outcome from the job's SSE stream, not this response.
    await pipeline_service.cancel(run_id, vault_id)
