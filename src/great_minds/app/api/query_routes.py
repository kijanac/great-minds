"""Query routes."""

import json
from uuid import UUID

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse

from great_minds.app.api.dependencies import (
    get_brain_service,
    get_brain_storage,
    get_current_user,
    get_document_repository,
    require_llm,
)
from great_minds.app.api.schemas import query as schemas
from great_minds.core import querier
from great_minds.core.brains.service import BrainService
from great_minds.core.documents.repository import DocumentRepository
from great_minds.core.storage import Storage
from great_minds.core.users.models import User

router = APIRouter(prefix="/query", tags=["query"])


@router.post("")
async def query(
    req: schemas.QueryRequest,
    brain_id: UUID,
    storage: Storage = Depends(get_brain_storage),
    user: User = Depends(get_current_user),
    brain_service: BrainService = Depends(get_brain_service),
    doc_repo: DocumentRepository = Depends(get_document_repository),
    _llm: None = Depends(require_llm),
) -> schemas.QueryResponse:
    brain = await brain_service.get_by_id(brain_id)
    all_sources = await brain_service.get_all_query_sources(user.id)
    target = querier.QuerySource(storage=storage, label=brain.name, brain_id=brain_id)
    sources = [target] + [s for s in all_sources if s.label != target.label]
    answer = await querier.run_query(
        sources,
        req.question,
        doc_repo,
        model=req.model,
        origin_path=req.origin_path,
        session_context=req.session_context,
        mode=req.mode,
    )
    return schemas.QueryResponse(answer=answer)


@router.post("/stream")
async def query_stream(
    req: schemas.QueryRequest,
    brain_id: UUID,
    storage: Storage = Depends(get_brain_storage),
    user: User = Depends(get_current_user),
    brain_service: BrainService = Depends(get_brain_service),
    doc_repo: DocumentRepository = Depends(get_document_repository),
    _llm: None = Depends(require_llm),
) -> StreamingResponse:
    brain = await brain_service.get_by_id(brain_id)
    all_sources = await brain_service.get_all_query_sources(user.id)
    target = querier.QuerySource(storage=storage, label=brain.name, brain_id=brain_id)
    sources = [target] + [s for s in all_sources if s.label != target.label]

    async def event_generator():
        async for event in querier.run_stream_query(
            sources,
            req.question,
            doc_repo,
            model=req.model,
            origin_path=req.origin_path,
            session_context=req.session_context,
            mode=req.mode,
        ):
            etype = event["event"]
            data = json.dumps(event["data"])
            yield f"event: {etype}\ndata: {data}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
