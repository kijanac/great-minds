"""Durable task execution backed by absurd-sdk (Postgres).

Tasks survive process restarts and are visible across workers.
AsyncAbsurd instance is managed via FastAPI lifespan + DI — no globals.

    # In routes:
    absurd: AsyncAbsurd = Depends(get_absurd)
    record = await spawn_compile(absurd, session, brain_id=..., ...)
"""

import logging
from contextvars import ContextVar
from datetime import UTC, datetime
from functools import partial
from pathlib import Path
from uuid import UUID

from absurd_sdk import AbsurdHooks, AsyncAbsurd
from sqlalchemy import DateTime, ForeignKey, Text, select, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlalchemy.orm import Mapped, mapped_column

from great_minds.core.brain import load_prompt
from great_minds.core.brains import _compiler as compiler
from great_minds.core.brains._linter import lint_links_to_slugs
from great_minds.core.brains.repository import BrainRepository
from great_minds.core.db import Base
from great_minds.core.storage import LocalStorage

_task_session: ContextVar[AsyncSession] = ContextVar("task_session")

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Task record (maps absurd task_id → brain for listing/querying)
# ---------------------------------------------------------------------------


class TaskRecord(Base):
    __tablename__ = "tasks"

    id: Mapped[UUID] = mapped_column(PG_UUID, primary_key=True)
    brain_id: Mapped[UUID] = mapped_column(
        PG_UUID, ForeignKey("brains.id", ondelete="CASCADE"), index=True,
    )
    type: Mapped[str] = mapped_column(Text)
    params: Mapped[dict] = mapped_column(JSONB, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()"),
    )


# ---------------------------------------------------------------------------
# Task functions (module-level, registered by register_tasks())
# ---------------------------------------------------------------------------


async def compile_task(params: dict, ctx) -> dict:
    """Run the compilation pipeline with heartbeat for long runs.

    For team brains, also checks cross-brain link integrity after compilation.
    """
    data_dir = Path(params["data_dir"])
    storage = LocalStorage(data_dir / params["storage_root"])
    brain_id = UUID(params["brain_id"])
    session = _task_session.get()

    await ctx.heartbeat(600)
    result = await compiler.run(
        storage, partial(load_prompt, storage),
        limit=params.get("limit"),
        db_session=session,
        brain_id=brain_id,
    )

    result_dict = {
        "docs_compiled": result.docs_compiled,
        "articles_written": [
            {"slug": a["slug"], "action": a["action"]}
            for a in result.articles_written
        ],
        "chunks_indexed": result.chunks_indexed,
    }

    # Post-compile: check cross-brain links for team brains
    if params.get("brain_kind") == "team" and result.articles_written:
        changed_slugs = [a["slug"] for a in result.articles_written]
        brain_id = UUID(params["brain_id"])

        log.info(
            "post_compile_lint brain=%s changed_slugs=%d",
            params["label"], len(changed_slugs),
        )

        session = _task_session.get()
        repo = BrainRepository(session)
        personal_brains = await repo.list_team_member_personal_brains(brain_id)

        peer_brains = [
            (LocalStorage(data_dir / b.storage_root), b.slug)
            for b in personal_brains
        ]

        if peer_brains:
            lint_result = lint_links_to_slugs(peer_brains, changed_slugs, storage)
            if lint_result.broken_links:
                log.warning(
                    "post_compile_lint brain=%s broken_links=%d",
                    params["label"], len(lint_result.broken_links),
                )
                for bl in lint_result.broken_links:
                    log.warning(
                        "broken_link brain=%s article=%s target=%s",
                        bl.brain_label, bl.article, bl.target_slug,
                    )
                result_dict["broken_links"] = len(lint_result.broken_links)

    return result_dict


# ---------------------------------------------------------------------------
# Lifecycle (called from FastAPI lifespan)
# ---------------------------------------------------------------------------


def create_absurd(database_url: str, session_maker: async_sessionmaker) -> AsyncAbsurd:
    """Create and configure an AsyncAbsurd instance with all tasks registered."""
    url = database_url.replace("+asyncpg", "")

    async def wrap_with_session(ctx, execute):
        async with session_maker() as session:
            token = _task_session.set(session)
            try:
                return await execute()
            finally:
                _task_session.reset(token)

    hooks = AbsurdHooks(wrap_task_execution=wrap_with_session)
    app = AsyncAbsurd(url, queue_name="default", hooks=hooks)
    app.register_task("compile", default_max_attempts=3)(compile_task)
    return app


# ---------------------------------------------------------------------------
# Spawn helpers (all take AsyncAbsurd as first arg — no globals)
# ---------------------------------------------------------------------------


async def spawn_compile(
    absurd: AsyncAbsurd,
    session: AsyncSession,
    brain_id: UUID,
    storage_root: str,
    data_dir: str,
    label: str,
    brain_kind: str,
    *,
    limit: int | None = None,
) -> TaskRecord:
    """Spawn a compile task. Returns existing active task if one is already running."""
    active = await _find_active_compile(absurd, session, brain_id)
    if active is not None:
        return active

    params = {
        "brain_id": str(brain_id),
        "storage_root": storage_root,
        "data_dir": data_dir,
        "label": label,
        "brain_kind": brain_kind,
        "limit": limit,
    }
    result = await absurd.spawn(
        "compile",
        params,
        max_attempts=3,
        retry_strategy={
            "kind": "exponential",
            "base_seconds": 10,
            "factor": 2,
            "max_seconds": 300,
        },
        idempotency_key=f"compile:{brain_id}",
    )

    record = TaskRecord(
        id=result["task_id"],
        brain_id=brain_id,
        type="compile",
        params=params,
        created_at=datetime.now(UTC),
    )
    session.add(record)
    await session.flush()

    log.info(
        "task_spawned task_id=%s type=compile brain_id=%s limit=%s",
        record.id, brain_id, limit,
    )
    return record


async def _find_active_compile(
    absurd: AsyncAbsurd,
    session: AsyncSession,
    brain_id: UUID,
) -> TaskRecord | None:
    """Return an active (non-terminal) compile task for this brain, if any."""
    rows = await session.execute(
        select(TaskRecord)
        .where(TaskRecord.brain_id == brain_id, TaskRecord.type == "compile")
        .order_by(TaskRecord.created_at.desc())
        .limit(10)
    )
    records = rows.scalars().all()

    for record in records:
        snapshot = await absurd.fetch_task_result(record.id)
        if snapshot is None or snapshot.state not in ("completed", "failed", "cancelled"):
            return record
    return None


# ---------------------------------------------------------------------------
# Query helpers (all take AsyncAbsurd as first arg)
# ---------------------------------------------------------------------------


async def fetch_task_response(absurd: AsyncAbsurd, record: TaskRecord) -> dict:
    """Build a response dict by fetching current status from absurd."""
    snapshot = await absurd.fetch_task_result(record.id)

    status = "pending"
    error = None
    result = {}

    if snapshot is not None:
        if snapshot.state == "completed":
            status = "completed"
            result = snapshot.result or {}
        elif snapshot.state == "failed":
            status = "failed"
            error = str(snapshot.failure) if snapshot.failure else "unknown error"
        elif snapshot.state == "cancelled":
            status = "cancelled"
        else:
            status = "running"

    return {
        "id": record.id,
        "type": record.type,
        "status": status,
        "created_at": record.created_at.isoformat(),
        "error": error,
        "params": record.params,
        "result": result,
    }


async def list_brain_tasks(
    absurd: AsyncAbsurd, session: AsyncSession, brain_id: UUID,
) -> list[dict]:
    """List all tasks for a brain with current status from absurd."""
    rows = await session.execute(
        select(TaskRecord)
        .where(TaskRecord.brain_id == brain_id)
        .order_by(TaskRecord.created_at.desc())
        .limit(100)
    )
    records = rows.scalars().all()
    return [await fetch_task_response(absurd, r) for r in records]


async def get_task(
    absurd: AsyncAbsurd, session: AsyncSession, task_id: UUID | str, brain_id: UUID,
) -> dict | None:
    """Get a single task by ID, scoped to a brain."""
    row = await session.execute(
        select(TaskRecord).where(
            TaskRecord.id == task_id,
            TaskRecord.brain_id == brain_id,
        )
    )
    record = row.scalar_one_or_none()
    if record is None:
        return None
    return await fetch_task_response(absurd, record)
