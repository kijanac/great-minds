"""Compile routes.

POST writes a CompileIntent and returns 202; the reconciler dispatches
it to Absurd within ~5s. GET lets the frontend poll the intent's status
(pending → dispatched → satisfied).
"""

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status

from great_minds.app.api.dependencies import (
    get_compile_intent_repository,
    require_brain_member,
    require_llm,
)
from great_minds.app.api.schemas.tasks import CompileRequest
from great_minds.core.compile_intents.repository import CompileIntentRepository
from great_minds.core.compile_intents.schemas import CompileIntent
from great_minds.core.telemetry import log_event

router = APIRouter(prefix="/compile", tags=["compile"])


@router.post("", status_code=status.HTTP_202_ACCEPTED)
async def request_compile(
    req: CompileRequest,
    brain_id: UUID,
    intent_repo: CompileIntentRepository = Depends(get_compile_intent_repository),
    _auth: None = Depends(require_brain_member),
    _llm: None = Depends(require_llm),
) -> CompileIntent:
    del req  # reserved for future compile options
    record = await intent_repo.upsert_pending(brain_id)
    if record is None:
        record = await intent_repo.get_pending_for_brain(brain_id)
    if record is None:
        # Race: a reconciler dispatched between upsert and lookup. Caller
        # should re-poll the brain's task list.
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Intent dispatched between request and lookup; refresh task list",
        )
    await intent_repo.session.commit()
    log_event(
        "intent_created",
        intent_id=str(record.id),
        brain_id=str(brain_id),
        trigger="api",
    )
    return CompileIntent.model_validate(record)


@router.get("/{intent_id}")
async def get_compile_intent(
    intent_id: UUID,
    brain_id: UUID,
    intent_repo: CompileIntentRepository = Depends(get_compile_intent_repository),
    _auth: None = Depends(require_brain_member),
) -> CompileIntent:
    record = await intent_repo.get(intent_id)
    if record is None or record.brain_id != brain_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Intent not found"
        )
    return CompileIntent.model_validate(record)
