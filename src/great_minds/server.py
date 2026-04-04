"""FastAPI server wrapping Brain operations.

Provides HTTP endpoints for compile, query, ingest, lint, and wiki browsing.
Compilation runs in the background via TaskManager.

    great-minds serve
    great-minds serve --port 8080
"""


import asyncio
import logging
from pathlib import Path

from fastapi import FastAPI, HTTPException, UploadFile
from pydantic import BaseModel

from .brain import Brain
from .storage import LocalStorage
from .tasks import TaskInfo, TaskManager

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


class ArticleResponse(BaseModel):
    slug: str
    content: str


class LintResponse(BaseModel):
    total_issues: int


# ---------------------------------------------------------------------------
# App factory
# ---------------------------------------------------------------------------


def create_app(brain: Brain | None = None) -> FastAPI:
    """Create the FastAPI app. Uses cwd as brain root if none provided."""
    if brain is None:
        brain = Brain(LocalStorage(Path.cwd()))

    manager = TaskManager(brain)

    app = FastAPI(
        title="Great Minds",
        description="LLM-powered research knowledge base",
        version="0.1.0",
    )

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

    # ------------------------------------------------------------------
    # Compilation (background)
    # ------------------------------------------------------------------

    @app.post("/compile", response_model=TaskResponse)
    async def compile(req: CompileRequest) -> TaskResponse:
        task_id = await manager.compile(limit=req.limit)
        info = manager.get(task_id)
        return _task_to_response(info)

    # ------------------------------------------------------------------
    # Tasks
    # ------------------------------------------------------------------

    @app.get("/tasks", response_model=list[TaskResponse])
    async def list_tasks() -> list[TaskResponse]:
        return [_task_to_response(t) for t in manager.list()]

    @app.get("/tasks/{task_id}", response_model=TaskResponse)
    async def get_task(task_id: str) -> TaskResponse:
        info = manager.get(task_id)
        if not info:
            raise HTTPException(status_code=404, detail="Task not found")
        return _task_to_response(info)

    # ------------------------------------------------------------------
    # Query
    # ------------------------------------------------------------------

    @app.post("/query", response_model=QueryResponse)
    async def query(req: QueryRequest) -> QueryResponse:
        answer = await asyncio.to_thread(brain.query, req.question, model=req.model)
        return QueryResponse(answer=answer)

    # ------------------------------------------------------------------
    # Ingest
    # ------------------------------------------------------------------

    @app.post("/ingest")
    async def ingest(req: IngestRequest) -> dict:
        kwargs = {}
        if req.title:
            kwargs["title"] = req.title
        if req.author:
            kwargs["author"] = req.author
        if req.date is not None:
            kwargs["date"] = req.date
        if req.source:
            kwargs["source"] = req.source

        result = brain.ingest_document(
            req.content,
            req.content_type,
            dest=req.dest,
            **kwargs,
        )
        return {"status": "ingested", "chars": len(result)}

    @app.post("/ingest/upload")
    async def ingest_upload(
        file: UploadFile,
        content_type: str = "texts",
        author: str | None = None,
        date: str | None = None,
        source: str | None = None,
    ) -> dict:
        content = (await file.read()).decode("utf-8")
        kwargs = {}
        if author:
            kwargs["author"] = author
        if date:
            kwargs["date"] = date
        if source:
            kwargs["source"] = source

        result = brain.ingest_document(content, content_type, **kwargs)
        return {"status": "ingested", "filename": file.filename, "chars": len(result)}

    # ------------------------------------------------------------------
    # Wiki browsing
    # ------------------------------------------------------------------

    @app.get("/wiki", response_model=list[str])
    async def list_articles() -> list[str]:
        paths = brain.storage.glob("wiki/*.md")
        return [
            p.removeprefix("wiki/").removesuffix(".md")
            for p in paths
            if not p.startswith("wiki/_")
        ]

    @app.get("/wiki/{slug}", response_model=ArticleResponse)
    async def read_article(slug: str) -> ArticleResponse:
        content = brain.storage.read(f"wiki/{slug}.md", default=None)
        if content is None:
            raise HTTPException(status_code=404, detail=f"Article not found: {slug}")
        return ArticleResponse(slug=slug, content=content)

    @app.get("/wiki/_index")
    async def read_index() -> dict:
        return {"content": brain.storage.read("wiki/_index.md", default="")}

    # ------------------------------------------------------------------
    # Lint
    # ------------------------------------------------------------------

    @app.get("/lint", response_model=LintResponse)
    async def lint(deep: bool = False) -> LintResponse:
        total = await asyncio.to_thread(brain.lint, deep=deep)
        return LintResponse(total_issues=total)

    return app
