"""Background task workers and absurd lifecycle.

Task functions run in a worker process and reconstruct their own
Storage/session from serialized params — they don't use the DI chain.
"""

import hashlib
import logging
from contextvars import ContextVar
from datetime import UTC, datetime
from functools import partial
from pathlib import Path
from uuid import UUID

from absurd_sdk import AbsurdHooks, AsyncAbsurd
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from great_minds.core.brain import load_config, load_prompt
from great_minds.core import compiler, ingester, linter
from great_minds.core.brain_utils import parse_frontmatter
from great_minds.core.documents.repository import DocumentRepository
from great_minds.core.documents.schemas import DocumentCreate
from great_minds.core.storage import LocalStorage, Storage
from great_minds.core.tasks.models import TaskRecord

_task_session: ContextVar[AsyncSession] = ContextVar("task_session")

log = logging.getLogger(__name__)


async def _run_lint_and_store(storage: Storage) -> None:
    """Run lint with auto-fix and persist results to storage."""
    result = await linter.run_lint(storage, fix=True)
    response = linter.LintResponse.model_validate(result, from_attributes=True)
    storage.write(linter.LINT_STORAGE_PATH, response.model_dump_json())


# ---------------------------------------------------------------------------
# Task functions
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
        post_write_hook=_run_lint_and_store,
    )

    return {
        "docs_compiled": result.docs_compiled,
        "articles_written": [
            {"slug": a["slug"], "action": a["action"]} for a in result.articles_written
        ],
        "chunks_indexed": result.chunks_indexed,
    }


async def bulk_ingest_task(params: dict, ctx) -> dict:
    """Bulk ingest a directory of files into a brain."""
    data_dir = Path(params["data_dir"])
    storage = LocalStorage(data_dir / "brains" / params["brain_id"])
    brain_id = UUID(params["brain_id"])
    source_dir = Path(params["source_dir"])
    content_type = params.get("content_type", "texts")
    dest_dir = params.get("dest_dir", f"raw/{content_type}")
    ingest_kwargs = params.get("ingest_kwargs", {})

    session = _task_session.get()
    config = load_config(storage)

    doc_repo = DocumentRepository(session)
    existing_hashes = await doc_repo.get_file_hashes(brain_id)

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
            storage, config, raw_content, content_type, dest=dest, **ingest_kwargs
        )
        file_hash = hashlib.sha256(content_with_fm.encode()).hexdigest()

        if existing_hashes.get(dest) == file_hash:
            skipped += 1
            continue

        storage.write(dest, content_with_fm)
        ingested += 1

        fm, _ = parse_frontmatter(content_with_fm)
        batch.append(DocumentCreate.from_frontmatter(fm, dest, content_with_fm))

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

    compile_result = None
    if ingested > 0:
        log.info("bulk_ingest: triggering compilation")
        await ctx.heartbeat(600)
        compile_result = await compiler.run(
            storage,
            partial(load_prompt, storage),
            db_session=session,
            brain_id=brain_id,
            post_write_hook=_run_lint_and_store,
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
# Spawn helpers (used by ProposalService — routes use TaskService instead)
# ---------------------------------------------------------------------------


async def spawn_compile(
    absurd: AsyncAbsurd,
    session: AsyncSession,
    brain_id: UUID,
    storage: Storage,
    data_dir: str,
    label: str,
    *,
    limit: int | None = None,
) -> TaskRecord:
    params = {
        "brain_id": str(brain_id),
        "data_dir": data_dir,
        "label": label,
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
        idempotency_key=compiler.compile_idempotency_key(brain_id, storage),
    )

    task_id = result["task_id"]
    await session.execute(
        insert(TaskRecord)
        .values(
            id=task_id,
            brain_id=brain_id,
            type="compile",
            params=params,
            created_at=datetime.now(UTC),
        )
        .on_conflict_do_nothing(index_elements=["id"])
    )

    record = await session.get(TaskRecord, task_id)
    if record is None:
        raise RuntimeError(f"TaskRecord {task_id} missing after upsert")

    log.info("task_spawned task_id=%s type=compile brain_id=%s", task_id, brain_id)
    return record


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
