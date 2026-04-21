"""FastAPI server wrapping Brain operations.

great-minds serve
great-minds serve --port 8080
"""

import asyncio
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware

from great_minds.app.api.v1 import router as v1_router
from great_minds.core.db import engine, session_maker
from great_minds.core.settings import get_settings
from great_minds.core.telemetry import (
    correlation_id,
    emit_wide_event,
    enrich,
    init_wide_event,
    setup_logging,
)
from great_minds.core.workers import create_absurd


# ---------------------------------------------------------------------------
# Telemetry middleware — one wide event per HTTP request
# ---------------------------------------------------------------------------


class TelemetryMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        cid = request.headers.get("x-request-id") or f"req-{uuid.uuid4().hex[:8]}"
        correlation_id.set(cid)
        init_wide_event(
            "http_request",
            method=request.method,
            path=request.url.path,
        )
        try:
            response = await call_next(request)
        except Exception as e:
            enrich(status=500, error=type(e).__name__)
            emit_wide_event()
            raise

        route = request.scope.get("route")
        if route is not None and getattr(route, "path", None):
            enrich(route=route.path)
        user_id = getattr(request.state, "user_id", None)
        if user_id is not None:
            enrich(user_id=str(user_id))
        enrich(status=response.status_code)

        response.headers["x-request-id"] = cid
        emit_wide_event()
        return response


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
    setup_logging(service="great-minds", json_output=settings.log_json)

    app = FastAPI(
        title="Great Minds",
        description="LLM-powered research knowledge base",
        version="0.1.0",
        lifespan=lifespan,
    )

    app.add_middleware(TelemetryMiddleware)
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
