"""FastAPI server wrapping Brain operations.

    great-minds serve
    great-minds serve --port 8080
"""

import asyncio
import json
import logging

from fastapi import Depends, FastAPI, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from great_minds.api.auth.routes import router as auth_router
from great_minds.api.brains.dependencies import ResolvedBrain, resolve_brain
from great_minds.api.brains.routes import router as brain_router
from great_minds.api.db import lifespan
from great_minds.api.proposals.routes import router as proposal_router
from great_minds.core import querier, sessions
from great_minds.core.tasks import TaskInfo

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Request/response models
# ---------------------------------------------------------------------------


class CompileRequest(BaseModel):
    limit: int | None = None


class QueryRequest(BaseModel):
    question: str
    model: str | None = None


class IngestRequest(BaseModel):
    content: str
    content_type: str = "texts"
    title: str | None = None
    author: str | None = None
    date: str | int | None = None
    source: str | None = None
    dest: str | None = None


class TaskResponse(BaseModel):
    id: str
    type: str
    status: str
    created_at: str
    started_at: str | None
    completed_at: str | None
    error: str | None
    params: dict
    result: dict


class QueryResponse(BaseModel):
    answer: str


class ExchangeData(BaseModel):
    query: str
    thinking: list[dict] = []
    answer: str
    btws: list[dict] = []


class BtwData(BaseModel):
    anchor: str
    exchangeId: str
    paragraphIndex: int = -1
    messages: list[dict]


class CreateSessionRequest(BaseModel):
    session_id: str
    exchange: ExchangeData


class SessionPathResponse(BaseModel):
    path: str


class SessionResponse(BaseModel):
    id: str
    events: list[dict]


class SessionListItem(BaseModel):
    id: str
    query: str
    created: str
    updated: str
    sources: list[str] = []


class ArticleResponse(BaseModel):
    slug: str
    content: str


class LintResponse(BaseModel):
    total_issues: int


# ---------------------------------------------------------------------------
# App factory
# ---------------------------------------------------------------------------


def _task_to_response(info: TaskInfo) -> TaskResponse:
    return TaskResponse(
        id=info.id,
        type=info.type,
        status=info.status,
        created_at=info.created_at.isoformat(),
        started_at=info.started_at.isoformat() if info.started_at else None,
        completed_at=info.completed_at.isoformat() if info.completed_at else None,
        error=info.error,
        params=info.params,
        result=info.result,
    )


def create_app() -> FastAPI:
    app = FastAPI(
        title="Great Minds",
        description="LLM-powered research knowledge base",
        version="0.1.0",
        lifespan=lifespan,
    )

    app.include_router(auth_router)
    app.include_router(brain_router)
    app.include_router(proposal_router)

    @app.post("/compile", response_model=TaskResponse)
    async def compile(req: CompileRequest, resolved: ResolvedBrain = Depends(resolve_brain)) -> TaskResponse:
        task_id = await resolved.manager.compile(limit=req.limit)
        info = resolved.manager.get(task_id)
        return _task_to_response(info)

    @app.get("/tasks", response_model=list[TaskResponse])
    async def list_tasks(resolved: ResolvedBrain = Depends(resolve_brain)) -> list[TaskResponse]:
        return [_task_to_response(t) for t in resolved.manager.list()]

    @app.get("/tasks/{task_id}", response_model=TaskResponse)
    async def get_task(task_id: str, resolved: ResolvedBrain = Depends(resolve_brain)) -> TaskResponse:
        info = resolved.manager.get(task_id)
        if not info:
            raise HTTPException(status_code=404, detail="Task not found")
        return _task_to_response(info)

    @app.post("/query", response_model=QueryResponse)
    async def query(req: QueryRequest, resolved: ResolvedBrain = Depends(resolve_brain)) -> QueryResponse:
        answer = await asyncio.to_thread(
            resolved.instance.query, req.question, model=req.model, sources=resolved.all_brains,
        )
        return QueryResponse(answer=answer)

    @app.post("/query/stream")
    async def query_stream(req: QueryRequest, resolved: ResolvedBrain = Depends(resolve_brain)) -> StreamingResponse:
        async def event_generator():
            async for event in querier.run_stream_query(
                resolved.all_brains, req.question, model=req.model,
            ):
                etype = event["event"]
                data = json.dumps(event["data"])
                yield f"event: {etype}\ndata: {data}\n\n"

        return StreamingResponse(
            event_generator(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    @app.post("/sessions", response_model=SessionPathResponse, status_code=201)
    async def create_session(req: CreateSessionRequest, resolved: ResolvedBrain = Depends(resolve_brain)) -> SessionPathResponse:
        path = sessions.create_session(resolved.instance.storage, req.session_id, req.exchange.model_dump())
        return SessionPathResponse(path=path)

    @app.patch("/sessions/{session_id}", response_model=SessionPathResponse)
    async def append_to_session(session_id: str, exchange: ExchangeData, resolved: ResolvedBrain = Depends(resolve_brain)) -> SessionPathResponse:
        path = sessions.append_exchange(resolved.instance.storage, session_id, exchange.model_dump())
        return SessionPathResponse(path=path)

    @app.patch("/sessions/{session_id}/btw", response_model=SessionPathResponse)
    async def append_btw_to_session(session_id: str, btw: BtwData, resolved: ResolvedBrain = Depends(resolve_brain)) -> SessionPathResponse:
        path = sessions.append_btw(resolved.instance.storage, session_id, btw.model_dump())
        return SessionPathResponse(path=path)

    @app.get("/sessions", response_model=list[SessionListItem])
    async def list_all_sessions(resolved: ResolvedBrain = Depends(resolve_brain)) -> list[SessionListItem]:
        raw = sessions.list_sessions(resolved.instance.storage)
        return [
            SessionListItem(id=s["id"], query=s["query"], created=s.get("ts", ""), updated=s.get("updated", s.get("ts", "")))
            for s in raw
        ]

    @app.get("/sessions/{session_id}", response_model=SessionResponse)
    async def read_session(session_id: str, resolved: ResolvedBrain = Depends(resolve_brain)) -> SessionResponse:
        try:
            events = sessions.load_events(resolved.instance.storage, session_id)
        except FileNotFoundError:
            raise HTTPException(status_code=404, detail="Session not found")
        return SessionResponse(id=session_id, events=events)

    @app.post("/ingest")
    async def ingest(req: IngestRequest, resolved: ResolvedBrain = Depends(resolve_brain)) -> dict:
        kwargs = {}
        if req.title:
            kwargs["title"] = req.title
        if req.author:
            kwargs["author"] = req.author
        if req.date is not None:
            kwargs["date"] = req.date
        if req.source:
            kwargs["source"] = req.source
        result = resolved.instance.ingest_document(req.content, req.content_type, dest=req.dest, **kwargs)
        return {"status": "ingested", "chars": len(result)}

    @app.post("/ingest/upload")
    async def ingest_upload(file: UploadFile, content_type: str = "texts", author: str | None = None, date: str | None = None, source: str | None = None, resolved: ResolvedBrain = Depends(resolve_brain)) -> dict:
        content = (await file.read()).decode("utf-8")
        kwargs = {}
        if author:
            kwargs["author"] = author
        if date:
            kwargs["date"] = date
        if source:
            kwargs["source"] = source
        result = resolved.instance.ingest_document(content, content_type, **kwargs)
        return {"status": "ingested", "filename": file.filename, "chars": len(result)}

    @app.get("/wiki", response_model=list[str])
    async def list_articles(resolved: ResolvedBrain = Depends(resolve_brain)) -> list[str]:
        paths = resolved.instance.storage.glob("wiki/*.md")
        return [p.removeprefix("wiki/").removesuffix(".md") for p in paths if not p.startswith("wiki/_")]

    @app.get("/wiki/{slug}", response_model=ArticleResponse)
    async def read_article(slug: str, resolved: ResolvedBrain = Depends(resolve_brain)) -> ArticleResponse:
        content = resolved.instance.storage.read(f"wiki/{slug}.md", default=None)
        if content is None:
            raise HTTPException(status_code=404, detail=f"Article not found: {slug}")
        return ArticleResponse(slug=slug, content=content)

    @app.get("/wiki/_index")
    async def read_index(resolved: ResolvedBrain = Depends(resolve_brain)) -> dict:
        return {"content": resolved.instance.storage.read("wiki/_index.md", default="")}

    @app.get("/lint", response_model=LintResponse)
    async def lint(deep: bool = False, resolved: ResolvedBrain = Depends(resolve_brain)) -> LintResponse:
        total = await asyncio.to_thread(resolved.instance.lint, deep=deep)
        return LintResponse(total_issues=total)

    return app
