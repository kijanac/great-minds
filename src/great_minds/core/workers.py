"""Background task workers and absurd lifecycle.

Task functions run in a worker process and reconstruct their own
Storage/session from serialized params — they don't use the DI chain.
"""

import hashlib
import logging
from contextvars import ContextVar
from pathlib import Path
from uuid import UUID

from absurd_sdk import AbsurdHooks, AsyncAbsurd
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from great_minds.core import ingester, pipeline
from great_minds.core.brain import load_config
from great_minds.core.compile_intents.repository import CompileIntentRepository
from great_minds.core.documents.repository import DocumentRepository
from great_minds.core.documents.schemas import DocumentCreate
from great_minds.core.llm import get_async_client
from great_minds.core.markdown import parse_frontmatter
from great_minds.core.paths import raw_prefix
from great_minds.core.storage_factory import make_storage
from great_minds.core.telemetry import (
    correlation_id,
    emit_wide_event,
    enrich,
    init_wide_event,
    timed_op,
)

_task_session: ContextVar[AsyncSession] = ContextVar("task_session")

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Task functions
# ---------------------------------------------------------------------------


async def compile_task(params: dict, ctx) -> None:
    """Run the seven-phase compile pipeline with heartbeat for long runs.

    Telemetry (per-phase counters, cost, duration) is emitted via
    `emit_wide_event` for the structured-log pipeline; nothing is
    returned through the task result.
    """
    correlation_id.set(f"task-{ctx.task_id}")
    brain_id = UUID(params["brain_id"])
    storage = make_storage(brain_id)
    session = _task_session.get()
    client = get_async_client()

    init_wide_event("compile", brain_id=str(brain_id))
    await ctx.heartbeat(600)

    pipeline_ctx = await pipeline.build_context(
        brain_id=brain_id, storage=storage, session=session, client=client
    )
    await pipeline.run(pipeline_ctx)

    emit_wide_event()


async def bulk_ingest_task(params: dict, ctx) -> None:
    """Bulk ingest a directory of files into a brain."""
    correlation_id.set(f"task-{ctx.task_id}")
    brain_id = UUID(params["brain_id"])
    storage = make_storage(brain_id)
    source_dir = Path(params["source_dir"])
    content_type = params.get("content_type", "texts")
    dest_dir = params.get("dest_dir", raw_prefix(content_type))
    ingest_kwargs = params.get("ingest_kwargs", {})

    session = _task_session.get()
    config = await load_config(storage)

    doc_repo = DocumentRepository(session)
    intent_repo = CompileIntentRepository(session)
    existing_hashes = await doc_repo.get_file_hashes(brain_id)

    source_files = sorted(source_dir.rglob("*.md"))
    total = len(source_files)
    ingested = 0
    skipped = 0
    batch: list[DocumentCreate] = []
    batch_size = 50

    init_wide_event(
        "bulk_ingested",
        brain_id=str(brain_id),
        source_dir=str(source_dir),
        content_type=content_type,
        total_files=total,
    )

    log.info(
        "bulk_ingest brain=%s source=%s files=%d",
        params.get("label"),
        source_dir,
        total,
    )

    async with timed_op("ingest"):
        for i, filepath in enumerate(source_files):
            if i % 100 == 0:
                await ctx.heartbeat(600)

            relative = filepath.relative_to(source_dir)
            dest = f"{dest_dir}/{relative}"

            raw_content = filepath.read_text(encoding="utf-8")
            content_with_fm = await ingester.ingest_document(
                storage, config, raw_content, content_type, dest=dest, **ingest_kwargs
            )
            file_hash = hashlib.sha256(content_with_fm.encode()).hexdigest()

            if existing_hashes.get(dest) == file_hash:
                skipped += 1
                continue

            await storage.write(dest, content_with_fm)
            ingested += 1

            fm, _ = parse_frontmatter(content_with_fm)
            batch.append(DocumentCreate.from_frontmatter(fm, dest, content_with_fm))

            if len(batch) >= batch_size:
                await doc_repo.batch_upsert(brain_id, batch)
                # Outbox: every commit that persists docs also persists the
                # intent (idempotent — the partial unique index coalesces).
                await intent_repo.upsert_pending(brain_id)
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
            await intent_repo.upsert_pending(brain_id)
            await session.commit()

    enrich(ingested=ingested, skipped=skipped)
    log.info(
        "bulk_ingest complete brain=%s ingested=%d skipped=%d total=%d",
        params.get("label"),
        ingested,
        skipped,
        total,
    )
    emit_wide_event()


# ---------------------------------------------------------------------------
# Lifecycle
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
