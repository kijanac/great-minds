"""FastAPI server wrapping Brain operations.

great-minds serve
great-minds serve --port 8080
"""

import asyncio
import io
import json
import logging
from uuid import UUID
from contextlib import asynccontextmanager

import httpx
from absurd_sdk import AsyncAbsurd
from fastapi import Depends, FastAPI, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from markitdown import MarkItDown, StreamInfo
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.app.api.auth_routes import router as auth_router
from great_minds.app.api.brain_routes import router as brain_router
from great_minds.app.api.dependencies import (
    BrainContext,
    get_absurd,
    get_authorized_brain,
    get_brain_service,
    get_current_user,
    require_llm,
)
from great_minds.app.api.proposal_routes import router as proposal_router
from great_minds.core import brain as brain_ops
from great_minds.core import querier, sessions, tasks
from great_minds.core.brains import _linter as linter
from great_minds.core.brains._ingester import ingest_document, normalize_url, slugify
from great_minds.core.brains.service import BrainService
from great_minds.core.db import engine, get_session, session_maker
from great_minds.core.settings import Settings, get_settings
from great_minds.core.tasks import create_absurd
from great_minds.core.users.models import User

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Request/response models
# ---------------------------------------------------------------------------


class CompileRequest(BaseModel):
    limit: int | None = None


class QueryRequest(BaseModel):
    question: str
    model: str | None = None
    origin_path: str | None = None
    session_context: str | None = None
    mode: querier.QueryMode = querier.QueryMode.QUERY


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
    paragraph: str
    exchangeId: str
    paragraphIndex: int = -1
    messages: list[dict]


class CreateSessionRequest(BaseModel):
    session_id: str
    exchange: ExchangeData
    origin: str | None = None


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
    origin: str | None = None


class ArticleResponse(BaseModel):
    slug: str
    content: str


class DocResponse(BaseModel):
    path: str
    content: str


class LintResponse(BaseModel):
    total_issues: int


# ---------------------------------------------------------------------------
# Lifespan + app factory
# ---------------------------------------------------------------------------


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    absurd = create_absurd(settings.database_url, session_maker)
    app.state.absurd = absurd
    worker = asyncio.create_task(
        absurd.start_worker(concurrency=2, poll_interval=0.5),
    )
    yield
    absurd.stop_worker()
    worker.cancel()
    try:
        await worker
    except asyncio.CancelledError:
        pass
    await absurd.close()
    await engine.dispose()


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

    @app.get("/health")
    async def health():
        return {"status": "ok"}

    app.include_router(auth_router)
    app.include_router(brain_router)
    app.include_router(proposal_router)

    @app.post("/compile", response_model=TaskResponse)
    async def compile(
        req: CompileRequest,
        ctx: BrainContext = Depends(get_authorized_brain),
        session: AsyncSession = Depends(get_session),
        absurd: AsyncAbsurd = Depends(get_absurd),
        settings: Settings = Depends(get_settings),
        _: None = Depends(require_llm),
    ) -> TaskResponse:
        record = await tasks.spawn_compile(
            absurd,
            session,
            brain_id=ctx.brain.id,
            storage_root=ctx.brain.storage_root,
            data_dir=settings.data_dir,
            label=ctx.brain.slug,
            brain_kind=ctx.brain.kind,
            limit=req.limit,
        )
        response = await tasks.fetch_task_response(absurd, record)
        return TaskResponse(**response)

    @app.get("/tasks", response_model=list[TaskResponse])
    async def list_tasks(
        ctx: BrainContext = Depends(get_authorized_brain),
        session: AsyncSession = Depends(get_session),
        absurd: AsyncAbsurd = Depends(get_absurd),
    ) -> list[TaskResponse]:
        responses = await tasks.list_brain_tasks(absurd, session, ctx.brain.id)
        return [TaskResponse(**r) for r in responses]

    @app.get("/tasks/{task_id}", response_model=TaskResponse)
    async def get_task(
        task_id: UUID,
        ctx: BrainContext = Depends(get_authorized_brain),
        session: AsyncSession = Depends(get_session),
        absurd: AsyncAbsurd = Depends(get_absurd),
    ) -> TaskResponse:
        response = await tasks.get_task(absurd, session, task_id, ctx.brain.id)
        if response is None:
            raise HTTPException(status_code=404, detail="Task not found")
        return TaskResponse(**response)

    @app.post("/query", response_model=QueryResponse)
    async def query(
        req: QueryRequest,
        ctx: BrainContext = Depends(get_authorized_brain),
        user: User = Depends(get_current_user),
        brain_service: BrainService = Depends(get_brain_service),
        session: AsyncSession = Depends(get_session),
        _: None = Depends(require_llm),
    ) -> QueryResponse:
        all_sources = await brain_service.get_all_query_sources(user.id)
        target = querier.QuerySource(
            storage=ctx.storage, label=ctx.brain.slug, brain_id=ctx.brain.id
        )
        sources = [target] + [s for s in all_sources if s.label != target.label]
        answer = await querier.run_query(
            sources,
            req.question,
            session,
            model=req.model,
            origin_path=req.origin_path,
            session_context=req.session_context,
            mode=req.mode,
        )
        return QueryResponse(answer=answer)

    @app.post("/query/stream")
    async def query_stream(
        req: QueryRequest,
        ctx: BrainContext = Depends(get_authorized_brain),
        user: User = Depends(get_current_user),
        brain_service: BrainService = Depends(get_brain_service),
        session: AsyncSession = Depends(get_session),
        _: None = Depends(require_llm),
    ) -> StreamingResponse:
        all_sources = await brain_service.get_all_query_sources(user.id)
        target = querier.QuerySource(
            storage=ctx.storage, label=ctx.brain.slug, brain_id=ctx.brain.id
        )
        sources = [target] + [s for s in all_sources if s.label != target.label]

        async def event_generator():
            async for event in querier.run_stream_query(
                sources,
                req.question,
                session,
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

    @app.post("/sessions", response_model=SessionPathResponse, status_code=201)
    async def create_session(
        req: CreateSessionRequest,
        ctx: BrainContext = Depends(get_authorized_brain),
    ) -> SessionPathResponse:
        path = sessions.create_session(
            ctx.storage,
            req.session_id,
            req.exchange.model_dump(),
            origin=req.origin,
        )
        return SessionPathResponse(path=path)

    @app.patch("/sessions/{session_id}", response_model=SessionPathResponse)
    async def append_to_session(
        session_id: str,
        exchange: ExchangeData,
        ctx: BrainContext = Depends(get_authorized_brain),
    ) -> SessionPathResponse:
        path = sessions.append_exchange(ctx.storage, session_id, exchange.model_dump())
        return SessionPathResponse(path=path)

    @app.patch("/sessions/{session_id}/btw", response_model=SessionPathResponse)
    async def append_btw_to_session(
        session_id: str,
        btw: BtwData,
        ctx: BrainContext = Depends(get_authorized_brain),
    ) -> SessionPathResponse:
        path = sessions.append_btw(ctx.storage, session_id, btw.model_dump())
        return SessionPathResponse(path=path)

    @app.get("/sessions", response_model=list[SessionListItem])
    async def list_all_sessions(
        ctx: BrainContext = Depends(get_authorized_brain),
    ) -> list[SessionListItem]:
        raw = sessions.list_sessions(ctx.storage)
        return [
            SessionListItem(
                id=s["id"],
                query=s["query"],
                created=s.get("ts", ""),
                updated=s.get("updated", s.get("ts", "")),
                origin=s.get("origin"),
            )
            for s in raw
        ]

    @app.get("/sessions/{session_id}", response_model=SessionResponse)
    async def read_session(
        session_id: str,
        ctx: BrainContext = Depends(get_authorized_brain),
    ) -> SessionResponse:
        try:
            events = sessions.load_events(ctx.storage, session_id)
        except FileNotFoundError:
            raise HTTPException(status_code=404, detail="Session not found")
        return SessionResponse(id=session_id, events=events)

    async def _try_compile(
        ctx: BrainContext,
        session: AsyncSession,
        absurd: AsyncAbsurd,
        settings: Settings,
    ) -> None:
        """Best-effort compile trigger after ingestion. Skips if LLM not configured."""
        if not settings.openrouter_api_key:
            return
        await tasks.spawn_compile(
            absurd,
            session,
            brain_id=ctx.brain.id,
            storage_root=ctx.brain.storage_root,
            data_dir=settings.data_dir,
            label=ctx.brain.slug,
            brain_kind=ctx.brain.kind,
        )
        await session.commit()

    @app.post("/ingest")
    async def ingest(
        req: IngestRequest,
        ctx: BrainContext = Depends(get_authorized_brain),
        session: AsyncSession = Depends(get_session),
        absurd: AsyncAbsurd = Depends(get_absurd),
        settings: Settings = Depends(get_settings),
    ) -> dict:
        config = brain_ops.load_config(ctx.storage)
        kwargs = {}
        if req.title:
            kwargs["title"] = req.title
        if req.author:
            kwargs["author"] = req.author
        if req.date is not None:
            kwargs["date"] = req.date
        if req.source:
            kwargs["source"] = req.source
        result = ingest_document(
            ctx.storage, config, req.content, req.content_type, dest=req.dest, **kwargs
        )
        await _try_compile(ctx, session, absurd, settings)
        return {"status": "ingested", "chars": len(result)}

    @app.post("/ingest/upload")
    async def ingest_upload(
        file: UploadFile,
        ctx: BrainContext = Depends(get_authorized_brain),
        session: AsyncSession = Depends(get_session),
        absurd: AsyncAbsurd = Depends(get_absurd),
        settings: Settings = Depends(get_settings),
        content_type: str = "texts",
        author: str | None = None,
        date: str | None = None,
        source: str | None = None,
    ) -> dict:
        config = brain_ops.load_config(ctx.storage)

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

        slug = slugify(filename.rsplit(".", 1)[0])
        dest = f"raw/{content_type}/{slug}.md"

        kwargs: dict = {}
        if author:
            kwargs["author"] = author
        if date:
            kwargs["date"] = date
        if source:
            kwargs["source"] = source
        ingested = ingest_document(
            ctx.storage, config, content, content_type, dest=dest, **kwargs
        )
        await _try_compile(ctx, session, absurd, settings)
        return {"status": "ingested", "name": filename, "chars": len(ingested)}

    @app.post("/ingest/url")
    async def ingest_url(
        req: IngestUrlRequest,
        ctx: BrainContext = Depends(get_authorized_brain),
        session: AsyncSession = Depends(get_session),
        absurd: AsyncAbsurd = Depends(get_absurd),
        settings: Settings = Depends(get_settings),
    ) -> dict:
        config = brain_ops.load_config(ctx.storage)

        url = normalize_url(req.url)
        try:
            async with httpx.AsyncClient(follow_redirects=True, timeout=30.0) as client:
                response = await client.get(
                    url,
                    headers={
                        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
                    },
                )
                response.raise_for_status()
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=400, detail=f"Failed to fetch URL: {exc}")

        converter = MarkItDown()
        result = await asyncio.to_thread(
            converter.convert_stream,
            io.BytesIO(response.content),
            stream_info=StreamInfo(
                extension=".html",
                mimetype=response.headers.get("content-type", "text/html"),
            ),
        )

        markdown = result.text_content
        title = result.title or url

        slug = slugify(title)
        dest = f"raw/{req.content_type}/{slug}.md"

        ingested = ingest_document(
            ctx.storage,
            config,
            markdown,
            req.content_type,
            dest=dest,
            title=title,
            source=url,
        )
        await _try_compile(ctx, session, absurd, settings)
        return {"status": "ingested", "name": title, "url": url, "chars": len(ingested)}

    @app.get("/wiki", response_model=list[str])
    async def list_articles(
        ctx: BrainContext = Depends(get_authorized_brain),
    ) -> list[str]:
        return brain_ops.list_articles(ctx.storage)

    @app.get("/wiki/{slug}", response_model=ArticleResponse)
    async def read_article(
        slug: str,
        ctx: BrainContext = Depends(get_authorized_brain),
    ) -> ArticleResponse:
        content = brain_ops.read_article(ctx.storage, slug)
        if content is None:
            raise HTTPException(status_code=404, detail=f"Article not found: {slug}")
        return ArticleResponse(slug=slug, content=content)

    @app.get("/doc/{path:path}", response_model=DocResponse)
    async def read_document(
        path: str,
        ctx: BrainContext = Depends(get_authorized_brain),
    ) -> DocResponse:
        content = ctx.storage.read(path, strict=False)
        if content is None:
            raise HTTPException(status_code=404, detail=f"Document not found: {path}")
        return DocResponse(path=path, content=content)

    @app.get("/lint", response_model=LintResponse)
    async def lint(
        deep: bool = False,
        ctx: BrainContext = Depends(get_authorized_brain),
    ) -> LintResponse:
        total = await asyncio.to_thread(linter.run_lint, ctx.storage, deep=deep)
        return LintResponse(total_issues=total)

    return app
