"""FastAPI server wrapping Vault operations.

great-minds serve
great-minds serve --port 8080
"""

import asyncio
import logging
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone, timedelta

from absurd_sdk import AsyncAbsurd
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from starlette.middleware.base import BaseHTTPMiddleware

from great_minds.app.api.v1 import router as v1_router
from great_minds.core.vaults.repository import VaultRepository
from great_minds.core.vaults.service import VaultService
from great_minds.core.compile_intents.reconciler import reconcile_once
from great_minds.core.compile_intents.repository import CompileIntentRepository
from great_minds.core.settings import Settings, get_settings
from great_minds.core.pipeline_runs.repository import PipelineRunRepository
from great_minds.core.tasks.repository import TaskRepository
from great_minds.core.tasks.service import TaskService
from great_minds.core.users.repository import UserRepository
from great_minds.core.telemetry import (
    correlation_id,
    emit_wide_event,
    enrich,
    init_wide_event,
    log_event,
    setup_logging,
)
from great_minds.core.workers import create_absurd

RECONCILER_INTERVAL_SECONDS = 5.0


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
    engine = create_async_engine(
        settings.database_url,
        pool_pre_ping=True,
        pool_recycle=60,  # recycle before Render kills idle connections
    )
    sm = async_sessionmaker(engine, expire_on_commit=False)

    absurd = create_absurd(settings.database_url, sm)
    app.state.absurd = absurd
    worker = asyncio.create_task(
        absurd.start_worker(concurrency=2, poll_interval=0.5),
    )

    # Compile-intent reconciler — single-process choice; tied to API
    # lifespan. To extract for multi-instance deployment, lift the loop
    # to a separate worker process or convert to a self-respawning
    # Absurd task. `reconcile_once` is the reusable unit.
    reconciler = asyncio.create_task(_reconciler_loop(sm, absurd, settings))

    yield {"session_maker": sm}

    reconciler.cancel()
    try:
        await reconciler
    except asyncio.CancelledError:
        pass
    absurd.stop_worker()
    worker.cancel()
    try:
        await worker
    except asyncio.CancelledError:
        pass
    await absurd.close()
    await engine.dispose()


async def _reconciler_loop(
    sm: async_sessionmaker,
    absurd: AsyncAbsurd,
    settings: Settings,
) -> None:
    log_event(
        "intent_reconciler_loop_started",
        interval_seconds=RECONCILER_INTERVAL_SECONDS,
    )
    while True:
        try:
            async with sm() as session:
                intent_repo = CompileIntentRepository(session)
                task_service = TaskService(TaskRepository(session), absurd)
                vault_service = VaultService(
                    VaultRepository(session),
                    UserRepository(session),
                    settings,
                )
                pipeline_run_repo = PipelineRunRepository(session)
                await reconcile_once(
                    intent_repo,
                    task_service,
                    vault_service,
                    pipeline_run_repo,
                    settings,
                )
                await _recover_zombie_pipeline_runs(pipeline_run_repo, task_service)
                await session.commit()
        except Exception as exc:
            log_event(
                "intent_reconciler_tick_failed",
                error_type=type(exc).__name__,
                error=str(exc),
                level=logging.WARNING,
            )
        await asyncio.sleep(RECONCILER_INTERVAL_SECONDS)


async def _recover_zombie_pipeline_runs(
    pipeline_run_repo: PipelineRunRepository,
    task_service: TaskService,
) -> None:
    """Detect pipeline runs whose Absurd task died (e.g. backend restart)
    and mark them as failed so the frontend doesn't hang forever."""
    zombie_threshold = datetime.now(timezone.utc) - timedelta(seconds=120)
    zombies = await pipeline_run_repo.list_stale_active(zombie_threshold)
    for run in zombies:
        task_id = run.active_task_id
        if task_id is None:
            await pipeline_run_repo.fail(
                run.id, "Pipeline lost — server may have restarted."
            )
            log_event(
                "zombie_pipeline_failed",
                pipeline_run_id=str(run.id),
                vault_id=str(run.vault_id),
                reason="no_active_task_id",
            )
            continue

        snapshot = await task_service.absurd.fetch_task_result(str(task_id))
        if snapshot is None or snapshot.state in ("failed", "cancelled"):
            await pipeline_run_repo.fail(
                run.id,
                "Pipeline interrupted — server may have restarted during processing.",
            )
            log_event(
                "zombie_pipeline_failed",
                pipeline_run_id=str(run.id),
                vault_id=str(run.vault_id),
                task_id=str(task_id),
                task_type=run.active_task_type,
                task_state=snapshot.state if snapshot else "missing",
            )


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
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.head("/")
    @app.get("/")
    def root() -> dict[str, str]:
        return {"status": "ok"}

    app.include_router(v1_router)

    return app
