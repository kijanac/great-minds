"""Query routes."""

import json
from uuid import UUID

from fastapi import APIRouter
from fastapi.responses import StreamingResponse

from great_minds.app.api.dependencies import (
    BrainServiceDep,
    BrainStorageDep,
    CurrentUser,
    DocumentServiceDep,
    LlmGuard,
)
from great_minds.app.api.schemas import query as schemas
from great_minds.core import querier

router = APIRouter(prefix="/query", tags=["query"])


@router.post("")
async def query(
    req: schemas.QueryRequest,
    brain_id: UUID,
    storage: BrainStorageDep,
    user: CurrentUser,
    brain_service: BrainServiceDep,
    doc_service: DocumentServiceDep,
    _llm: LlmGuard,
) -> StreamingResponse:
    """Stream answer events as SSE.

    Event shapes:
      - ``source``: an article/raw doc/search the agent consulted
      - ``token``:  a content delta from the model
      - ``done``:   final marker with sources_consulted summary
      - ``error``:  unrecoverable error before/during the stream
    """
    brain = await brain_service.get_brain(brain_id)
    source = querier.QuerySource(storage=storage, label=brain.name, brain_id=brain_id)

    async def event_generator():
        async for event in querier.run_query(
            source,
            req.question,
            doc_service,
            user_id=user.id,
            model=req.model,
            origin_path=req.origin_path,
            history=req.history,
            mode=req.mode,
            extra_instructions=req.extra_instructions,
        ):
            etype = event["event"]
            data = json.dumps(event["data"])
            yield f"event: {etype}\ndata: {data}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
