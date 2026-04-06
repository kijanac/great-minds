"""FastAPI server wrapping Brain operations.

    great-minds serve
    great-minds serve --port 8080
"""

import asyncio
import io
import json
import logging
import re
from uuid import UUID

import httpx
from fastapi import Depends, FastAPI, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from markitdown import MarkItDown, StreamInfo
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.app.api.auth_routes import router as auth_router
from great_minds.app.api.brain_routes import router as brain_router
from great_minds.app.api.dependencies import get_brain_service, get_current_user
from great_minds.app.api.proposal_routes import router as proposal_router
from great_minds.core import querier, sessions
from great_minds.core.brains.service import BrainService
from great_minds.core.db import get_session, lifespan
from great_minds.core.settings import get_settings
from great_minds.core.tasks import TaskInfo
from great_minds.core.users.models import User

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _slugify(text: str, max_len: int = 80) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:max_len]


def _normalize_url(url: str) -> str:
    if url.startswith("http://") or url.startswith("https://"):
        return url
    return f"https://{url}"


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


class IngestUrlRequest(BaseModel):
    url: str
    content_type: str = "texts"


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
    settings = get_settings()

    app = FastAPI(
        title="Great Minds",
        description="LLM-powered research knowledge base",
        version="0.1.0",
        lifespan=lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        max_age=3600,
    )

    app.include_router(auth_router)
    app.include_router(brain_router)
    app.include_router(proposal_router)

    @app.post("/compile", response_model=TaskResponse)
    async def compile(
        req: CompileRequest,
        brain_id: UUID = Query(...),
        user: User = Depends(get_current_user),
        session: AsyncSession = Depends(get_session),
        brain_service: BrainService = Depends(get_brain_service),
    ) -> TaskResponse:
        brain, _role = await brain_service.get_brain(session, brain_id, user.id)
        manager = brain_service.get_task_manager(brain)
        task_id = await manager.compile(limit=req.limit)
        info = manager.get(task_id)
        return _task_to_response(info)

    @app.get("/tasks", response_model=list[TaskResponse])
    async def list_tasks(
        brain_id: UUID = Query(...),
        user: User = Depends(get_current_user),
        session: AsyncSession = Depends(get_session),
        brain_service: BrainService = Depends(get_brain_service),
    ) -> list[TaskResponse]:
        brain, _role = await brain_service.get_brain(session, brain_id, user.id)
        manager = brain_service.get_task_manager(brain)
        return [_task_to_response(t) for t in manager.list_all()]

    @app.get("/tasks/{task_id}", response_model=TaskResponse)
    async def get_task(
        task_id: str,
        brain_id: UUID = Query(...),
        user: User = Depends(get_current_user),
        session: AsyncSession = Depends(get_session),
        brain_service: BrainService = Depends(get_brain_service),
    ) -> TaskResponse:
        brain, _role = await brain_service.get_brain(session, brain_id, user.id)
        manager = brain_service.get_task_manager(brain)
        info = manager.get(task_id)
        if not info:
            raise HTTPException(status_code=404, detail="Task not found")
        return _task_to_response(info)

    @app.post("/query", response_model=QueryResponse)
    async def query(
        req: QueryRequest,
        brain_id: UUID = Query(...),
        user: User = Depends(get_current_user),
        session: AsyncSession = Depends(get_session),
        brain_service: BrainService = Depends(get_brain_service),
    ) -> QueryResponse:
        all_sources = await brain_service.get_all_query_sources(session, user.id)
        # Put the targeted brain first
        brain, _role = await brain_service.get_brain(session, brain_id, user.id)
        instance = brain_service.build(brain)
        target = instance.as_query_source()
        sources = [target] + [s for s in all_sources if s.label != target.label]
        answer = await asyncio.to_thread(
            instance.query, req.question, model=req.model, sources=sources,
        )
        return QueryResponse(answer=answer)

    @app.post("/query/stream")
    async def query_stream(
        req: QueryRequest,
        brain_id: UUID = Query(...),
        user: User = Depends(get_current_user),
        session: AsyncSession = Depends(get_session),
        brain_service: BrainService = Depends(get_brain_service),
    ) -> StreamingResponse:
        all_sources = await brain_service.get_all_query_sources(session, user.id)
        brain, _role = await brain_service.get_brain(session, brain_id, user.id)
        instance = brain_service.build(brain)
        target = instance.as_query_source()
        sources = [target] + [s for s in all_sources if s.label != target.label]

        async def event_generator():
            async for event in querier.run_stream_query(
                sources, req.question, model=req.model,
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
    async def create_session(
        req: CreateSessionRequest,
        brain_id: UUID = Query(...),
        user: User = Depends(get_current_user),
        session: AsyncSession = Depends(get_session),
        brain_service: BrainService = Depends(get_brain_service),
    ) -> SessionPathResponse:
        brain, _role = await brain_service.get_brain(session, brain_id, user.id)
        instance = brain_service.build(brain)
        path = sessions.create_session(instance.storage, req.session_id, req.exchange.model_dump())
        return SessionPathResponse(path=path)

    @app.patch("/sessions/{session_id}", response_model=SessionPathResponse)
    async def append_to_session(
        session_id: str,
        exchange: ExchangeData,
        brain_id: UUID = Query(...),
        user: User = Depends(get_current_user),
        session: AsyncSession = Depends(get_session),
        brain_service: BrainService = Depends(get_brain_service),
    ) -> SessionPathResponse:
        brain, _role = await brain_service.get_brain(session, brain_id, user.id)
        instance = brain_service.build(brain)
        path = sessions.append_exchange(instance.storage, session_id, exchange.model_dump())
        return SessionPathResponse(path=path)

    @app.patch("/sessions/{session_id}/btw", response_model=SessionPathResponse)
    async def append_btw_to_session(
        session_id: str,
        btw: BtwData,
        brain_id: UUID = Query(...),
        user: User = Depends(get_current_user),
        session: AsyncSession = Depends(get_session),
        brain_service: BrainService = Depends(get_brain_service),
    ) -> SessionPathResponse:
        brain, _role = await brain_service.get_brain(session, brain_id, user.id)
        instance = brain_service.build(brain)
        path = sessions.append_btw(instance.storage, session_id, btw.model_dump())
        return SessionPathResponse(path=path)

    @app.get("/sessions", response_model=list[SessionListItem])
    async def list_all_sessions(
        brain_id: UUID = Query(...),
        user: User = Depends(get_current_user),
        session: AsyncSession = Depends(get_session),
        brain_service: BrainService = Depends(get_brain_service),
    ) -> list[SessionListItem]:
        brain, _role = await brain_service.get_brain(session, brain_id, user.id)
        instance = brain_service.build(brain)
        raw = sessions.list_sessions(instance.storage)
        return [
            SessionListItem(id=s["id"], query=s["query"], created=s.get("ts", ""), updated=s.get("updated", s.get("ts", "")))
            for s in raw
        ]

    @app.get("/sessions/{session_id}", response_model=SessionResponse)
    async def read_session(
        session_id: str,
        brain_id: UUID = Query(...),
        user: User = Depends(get_current_user),
        session: AsyncSession = Depends(get_session),
        brain_service: BrainService = Depends(get_brain_service),
    ) -> SessionResponse:
        brain, _role = await brain_service.get_brain(session, brain_id, user.id)
        instance = brain_service.build(brain)
        try:
            events = sessions.load_events(instance.storage, session_id)
        except FileNotFoundError:
            raise HTTPException(status_code=404, detail="Session not found")
        return SessionResponse(id=session_id, events=events)

    @app.post("/ingest")
    async def ingest(
        req: IngestRequest,
        brain_id: UUID = Query(...),
        user: User = Depends(get_current_user),
        session: AsyncSession = Depends(get_session),
        brain_service: BrainService = Depends(get_brain_service),
    ) -> dict:
        brain, _role = await brain_service.get_brain(session, brain_id, user.id)
        instance = brain_service.build(brain)
        kwargs = {}
        if req.title:
            kwargs["title"] = req.title
        if req.author:
            kwargs["author"] = req.author
        if req.date is not None:
            kwargs["date"] = req.date
        if req.source:
            kwargs["source"] = req.source
        result = instance.ingest_document(req.content, req.content_type, dest=req.dest, **kwargs)
        return {"status": "ingested", "chars": len(result)}

    @app.post("/ingest/upload")
    async def ingest_upload(
        file: UploadFile,
        brain_id: UUID = Query(...),
        content_type: str = "texts",
        author: str | None = None,
        date: str | None = None,
        source: str | None = None,
        user: User = Depends(get_current_user),
        session: AsyncSession = Depends(get_session),
        brain_service: BrainService = Depends(get_brain_service),
    ) -> dict:
        brain, _role = await brain_service.get_brain(session, brain_id, user.id)
        instance = brain_service.build(brain)

        raw_bytes = await file.read()
        filename = file.filename or "upload.md"
        ext = "." + filename.rsplit(".", 1)[-1].lower() if "." in filename else ".txt"

        if ext in (".md", ".txt", ".text", ".markdown"):
            content = raw_bytes.decode("utf-8")
        else:
            converter = MarkItDown()
            result = await asyncio.to_thread(
                converter.convert_stream,
                io.BytesIO(raw_bytes),
                stream_info=StreamInfo(extension=ext, mimetype=file.content_type or ""),
            )
            content = result.text_content

        slug = _slugify(filename.rsplit(".", 1)[0])
        dest = f"raw/{content_type}/{slug}.md"

        kwargs: dict = {}
        if author:
            kwargs["author"] = author
        if date:
            kwargs["date"] = date
        if source:
            kwargs["source"] = source
        ingested = instance.ingest_document(content, content_type, dest=dest, **kwargs)
        return {"status": "ingested", "name": filename, "chars": len(ingested)}

    @app.post("/ingest/url")
    async def ingest_url(
        req: IngestUrlRequest,
        brain_id: UUID = Query(...),
        user: User = Depends(get_current_user),
        session: AsyncSession = Depends(get_session),
        brain_service: BrainService = Depends(get_brain_service),
    ) -> dict:
        brain, _role = await brain_service.get_brain(session, brain_id, user.id)
        instance = brain_service.build(brain)

        url = _normalize_url(req.url)
        try:
            async with httpx.AsyncClient(follow_redirects=True, timeout=30.0) as client:
                response = await client.get(url, headers={
                    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
                })
                response.raise_for_status()
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=400, detail=f"Failed to fetch URL: {exc}")

        converter = MarkItDown()
        result = await asyncio.to_thread(
            converter.convert_stream,
            io.BytesIO(response.content),
            stream_info=StreamInfo(extension=".html", mimetype=response.headers.get("content-type", "text/html")),
        )

        markdown = result.text_content
        title = result.title or url

        slug = _slugify(title)
        dest = f"raw/{req.content_type}/{slug}.md"

        ingested = instance.ingest_document(
            markdown, req.content_type, dest=dest, title=title, source=url,
        )
        return {"status": "ingested", "name": title, "url": url, "chars": len(ingested)}

    @app.get("/wiki", response_model=list[str])
    async def list_articles(
        brain_id: UUID = Query(...),
        user: User = Depends(get_current_user),
        session: AsyncSession = Depends(get_session),
        brain_service: BrainService = Depends(get_brain_service),
    ) -> list[str]:
        brain, _role = await brain_service.get_brain(session, brain_id, user.id)
        return brain_service.build(brain).list_articles()

    @app.get("/wiki/{slug}", response_model=ArticleResponse)
    async def read_article(
        slug: str,
        brain_id: UUID = Query(...),
        user: User = Depends(get_current_user),
        session: AsyncSession = Depends(get_session),
        brain_service: BrainService = Depends(get_brain_service),
    ) -> ArticleResponse:
        brain, _role = await brain_service.get_brain(session, brain_id, user.id)
        content = brain_service.build(brain).read_article(slug)
        if content is None:
            raise HTTPException(status_code=404, detail=f"Article not found: {slug}")
        return ArticleResponse(slug=slug, content=content)

    @app.get("/wiki/_index")
    async def read_index(
        brain_id: UUID = Query(...),
        user: User = Depends(get_current_user),
        session: AsyncSession = Depends(get_session),
        brain_service: BrainService = Depends(get_brain_service),
    ) -> dict:
        brain, _role = await brain_service.get_brain(session, brain_id, user.id)
        return {"content": brain_service.build(brain).read_index()}

    @app.get("/lint", response_model=LintResponse)
    async def lint(
        brain_id: UUID = Query(...),
        deep: bool = False,
        user: User = Depends(get_current_user),
        session: AsyncSession = Depends(get_session),
        brain_service: BrainService = Depends(get_brain_service),
    ) -> LintResponse:
        brain, _role = await brain_service.get_brain(session, brain_id, user.id)
        total = await asyncio.to_thread(brain_service.build(brain).lint, deep=deep)
        return LintResponse(total_issues=total)

    return app
