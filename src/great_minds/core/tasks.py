"""Durable task execution backed by absurd-sdk (Postgres).

Tasks survive process restarts and are visible across workers.
AsyncAbsurd instance is managed via FastAPI lifespan + DI — no globals.

    # In routes:
    absurd: AsyncAbsurd = Depends(get_absurd)
    record = await spawn_compile(absurd, session, brain_id=..., ...)
"""

import hashlib
import logging
from contextvars import ContextVar
from datetime import UTC, datetime
from functools import partial
from pathlib import Path
from uuid import UUID

from absurd_sdk import AbsurdHooks, AsyncAbsurd
from sqlalchemy import DateTime, ForeignKey, Text, select, text
from sqlalchemy.dialects.postgresql import JSONB, UUID as PG_UUID, insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlalchemy.orm import Mapped, mapped_column

from great_minds.core.brain import load_config, load_prompt
from great_minds.core.brains import _compiler as compiler, _ingester as ingester
from great_minds.core.brains._utils import parse_frontmatter
from great_minds.core.db import Base
from great_minds.core.documents.repository import DocumentRepository
from great_minds.core.documents.schemas import DocumentCreate
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
        PG_UUID,
        ForeignKey("brains.id", ondelete="CASCADE"),
        index=True,
    )
    type: Mapped[str] = mapped_column(Text)
    params: Mapped[dict] = mapped_column(JSONB, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=text("now()"),
    )


# ---------------------------------------------------------------------------
# Task functions (module-level, registered by register_tasks())
# ---------------------------------------------------------------------------


async def compile_task(params: dict, ctx) -> dict:
    """Run the compilation pipeline with heartbeat for long runs."""
    data_dir = Path(params["data_dir"])
    storage = LocalStorage(data_dir / "brains" / params["brain_id"])
    brain_id = UUID(params["brain_id"])
    session = _task_session.get()

    await ctx.heartbeat(600)
    result = await compiler.run(
        storage,
        partial(load_prompt, storage),
        limit=params.get("limit"),
        db_session=session,
        brain_id=brain_id,
    )

    return {
        "docs_compiled": result.docs_compiled,
        "articles_written": [
            {"slug": a["slug"], "action": a["action"]} for a in result.articles_written
        ],
        "chunks_indexed": result.chunks_indexed,
    }


async def bulk_ingest_task(params: dict, ctx) -> dict:
    """Bulk ingest a directory of files into a brain.

    Skips files whose content hash already matches the documents table.
    Indexes all new/changed files, then triggers compilation.
    """
    data_dir = Path(params["data_dir"])
    storage = LocalStorage(data_dir / "brains" / params["brain_id"])
    brain_id = UUID(params["brain_id"])
    source_dir = Path(params["source_dir"])
    content_type = params.get("content_type", "texts")
    dest_dir = params.get("dest_dir", f"raw/{content_type}")
    ingest_kwargs = params.get("ingest_kwargs", {})

    session = _task_session.get()
    config = load_config(storage)

    # Get existing file hashes for skip detection
    doc_repo = DocumentRepository(session)
    existing_hashes = await doc_repo.get_file_hashes(brain_id)

    # Scan source directory
    source_files = sorted(source_dir.rglob("*.md"))
    total = len(source_files)
    ingested = 0
    skipped = 0
    batch: list[DocumentCreate] = []
    batch_size = 50

    log.info(
        "bulk_ingest brain=%s source=%s files=%d",
        params.get("label"),
        source_dir,
        total,
    )

    for i, filepath in enumerate(source_files):
        if i % 100 == 0:
            await ctx.heartbeat(600)

        relative = filepath.relative_to(source_dir)
        dest = f"{dest_dir}/{relative}"

        raw_content = filepath.read_text(encoding="utf-8")
        content_with_fm = ingester.ingest_document(
            storage, config, raw_content, content_type, dest=None, **ingest_kwargs
        )
        file_hash = hashlib.sha256(content_with_fm.encode()).hexdigest()

        if existing_hashes.get(dest) == file_hash:
            skipped += 1
            continue

        storage.write(dest, content_with_fm)
        ingested += 1

        fm, _ = parse_frontmatter(content_with_fm)
        batch.append(
            DocumentCreate.model_validate(
                {**fm, "file_path": dest, "content": content_with_fm}
            )
        )

        if len(batch) >= batch_size:
            await doc_repo.batch_upsert(brain_id, batch)
            await session.commit()
            batch.clear()

        if ingested % 100 == 0:
            log.info(
                "bulk_ingest progress=%d/%d ingested=%d skipped=%d",
                i + 1,
                total,
                ingested,
                skipped,
            )

    if batch:
        await doc_repo.batch_upsert(brain_id, batch)
        await session.commit()

    log.info(
        "bulk_ingest complete brain=%s ingested=%d skipped=%d total=%d",
        params.get("label"),
        ingested,
        skipped,
        total,
    )

    # Trigger compilation
    compile_result = None
    if ingested > 0:
        log.info("bulk_ingest: triggering compilation")
        await ctx.heartbeat(600)
        compile_result = await compiler.run(
            storage,
            partial(load_prompt, storage),
            db_session=session,
            brain_id=brain_id,
        )

    return {
        "total_files": total,
        "ingested": ingested,
        "skipped": skipped,
        "compiled": {
            "docs": compile_result.docs_compiled,
            "articles": len(compile_result.articles_written),
            "chunks_indexed": compile_result.chunks_indexed,
        }
        if compile_result
        else None,
    }


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
    app.register_task("bulk_ingest", default_max_attempts=2)(bulk_ingest_task)
    return app


# ---------------------------------------------------------------------------
# Spawn helpers (all take AsyncAbsurd as first arg — no globals)
# ---------------------------------------------------------------------------


async def _spawn_and_record(
    absurd: AsyncAbsurd,
    session: AsyncSession,
    task_type: str,
    brain_id: UUID,
    params: dict,
    *,
    max_attempts: int,
    retry_strategy: dict,
    idempotency_key: str,
) -> TaskRecord:
    """Spawn a durable task and create the TaskRecord index entry."""
    result = await absurd.spawn(
        task_type,
        params,
        max_attempts=max_attempts,
        retry_strategy=retry_strategy,
        idempotency_key=idempotency_key,
    )

    task_id = result["task_id"]
    await session.execute(
        insert(TaskRecord)
        .values(
            id=task_id,
            brain_id=brain_id,
            type=task_type,
            params=params,
            created_at=datetime.now(UTC),
        )
        .on_conflict_do_nothing(index_elements=["id"])
    )

    record = await session.get(TaskRecord, task_id)
    if record is None:
        raise RuntimeError(f"TaskRecord {task_id} missing after upsert")

    log.info(
        "task_spawned task_id=%s type=%s brain_id=%s", task_id, task_type, brain_id
    )
    return record


async def spawn_compile(
    absurd: AsyncAbsurd,
    session: AsyncSession,
    brain_id: UUID,
    data_dir: str,
    label: str,
    *,
    limit: int | None = None,
) -> TaskRecord:
    return await _spawn_and_record(
        absurd,
        session,
        "compile",
        brain_id,
        {
            "brain_id": str(brain_id),
            "data_dir": data_dir,
            "label": label,
            "limit": limit,
        },
        max_attempts=3,
        retry_strategy={
            "kind": "exponential",
            "base_seconds": 10,
            "factor": 2,
            "max_seconds": 300,
        },
        idempotency_key=f"compile:{brain_id}",
    )


async def spawn_bulk_ingest(
    absurd: AsyncAbsurd,
    session: AsyncSession,
    brain_id: UUID,
    data_dir: str,
    label: str,
    source_dir: str,
    content_type: str = "texts",
    dest_dir: str | None = None,
    ingest_kwargs: dict | None = None,
) -> TaskRecord:
    return await _spawn_and_record(
        absurd,
        session,
        "bulk_ingest",
        brain_id,
        {
            "brain_id": str(brain_id),
            "data_dir": data_dir,
            "label": label,
            "source_dir": source_dir,
            "content_type": content_type,
            "dest_dir": dest_dir or f"raw/{content_type}",
            "ingest_kwargs": ingest_kwargs or {},
        },
        max_attempts=2,
        retry_strategy={
            "kind": "exponential",
            "base_seconds": 30,
            "factor": 2,
            "max_seconds": 600,
        },
        idempotency_key=f"bulk_ingest:{brain_id}:{source_dir}",
    )


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
    absurd: AsyncAbsurd,
    session: AsyncSession,
    brain_id: UUID,
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
    absurd: AsyncAbsurd,
    session: AsyncSession,
    task_id: UUID,
    brain_id: UUID,
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
