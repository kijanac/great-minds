"""FastAPI server wrapping Brain operations.

great-minds serve
great-minds serve --port 8080
"""

import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from great_minds.app.api.v1 import router as v1_router
from great_minds.core.db import engine, session_maker
from great_minds.core.settings import get_settings
from great_minds.core.workers import create_absurd


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

    app.include_router(v1_router)

    return app
