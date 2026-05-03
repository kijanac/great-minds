"""Background task workers and absurd lifecycle.

Task functions run in a worker process and reconstruct their own
Storage/session from serialized params — they don't use the DI chain.
"""

import asyncio
import logging
from contextvars import ContextVar
from pathlib import Path
from uuid import UUID

from absurd_sdk import AbsurdHooks, AsyncAbsurd
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from great_minds.core.hashing import file_hash

from great_minds.core import pipeline
from great_minds.core.vaults.config import load_config
from great_minds.core.vaults.repository import VaultRepository
from great_minds.core.documents.builder import build_document, write_document
from great_minds.core.documents.repository import DocumentRepository
from great_minds.core.documents.schemas import DocumentCreate
from great_minds.core.documents.service import DocumentService
from great_minds.core.ingest_service import _convert_to_markdown
from great_minds.core.llm import get_async_client
from great_minds.core.llm_costs import record_wide_event_cost
from great_minds.core.markdown import parse_frontmatter
from great_minds.core.paths import raw_prefix
from great_minds.core.r2_admin import R2Admin
from great_minds.core.settings import get_settings
from great_minds.core.storage_factory import make_storage
from great_minds.core.telemetry import (
    correlation_id,
    emit_wide_event,
    enrich,
    init_wide_event,
    log_event,
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
    vault_id = UUID(params["vault_id"])
    session = _task_session.get()
    vault = await VaultRepository(session).get_by_id(vault_id)
    if vault is None:
        raise ValueError(f"Vault {vault_id} not found")
    storage = make_storage(vault)
    client = get_async_client()

    init_wide_event("compile", vault_id=str(vault_id))
    await ctx.heartbeat(600)

    pipeline_ctx = await pipeline.build_context(
        vault_id=vault_id, storage=storage, session=session, client=client
    )
    await pipeline.run(pipeline_ctx)

    await record_wide_event_cost(session, user_id=None, vault_id=vault_id)
    await session.commit()
    emit_wide_event()


async def bulk_ingest_task(params: dict, ctx) -> None:
    """Bulk ingest a directory of files into a vault."""
    correlation_id.set(f"task-{ctx.task_id}")
    vault_id = UUID(params["vault_id"])
    session = _task_session.get()
    vault = await VaultRepository(session).get_by_id(vault_id)
    if vault is None:
        raise ValueError(f"Vault {vault_id} not found")
    storage = make_storage(vault)
    source_dir = Path(params["source_dir"])
    content_type = params.get("content_type", "texts")
    dest_dir = params.get("dest_dir", raw_prefix(content_type))
    ingest_kwargs = params.get("ingest_kwargs", {})
    config = await load_config(storage)

    doc_service = DocumentService(DocumentRepository(session))
    existing_hashes = await doc_service.get_raw_file_hashes(vault_id)

    source_files = sorted(source_dir.rglob("*.md"))
    total = len(source_files)
    ingested = 0
    skipped = 0
    batch: list[DocumentCreate] = []
    batch_size = 50

    init_wide_event(
        "bulk_ingested",
        vault_id=str(vault_id),
        source_dir=str(source_dir),
        content_type=content_type,
        total_files=total,
    )

    log.info(
        "bulk_ingest vault=%s source=%s files=%d",
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
            content_with_fm = await write_document(
                storage, config, raw_content, content_type, dest=dest, **ingest_kwargs
            )
            file_hash_val = file_hash(content_with_fm)

            if existing_hashes.get(dest) == file_hash_val:
                skipped += 1
                continue

            await storage.write(dest, content_with_fm)
            ingested += 1

            fm, _ = parse_frontmatter(content_with_fm)
            batch.append(DocumentCreate.from_frontmatter(fm, dest, content_with_fm))

            if len(batch) >= batch_size:
                # batch_index_raw_docs upserts, emits a compile intent,
                # and commits — outbox semantics live in DocumentService.
                await doc_service.batch_index_raw_docs(vault_id, batch)
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
            await doc_service.batch_index_raw_docs(vault_id, batch)

    enrich(ingested=ingested, skipped=skipped)
    log.info(
        "bulk_ingest complete vault=%s ingested=%d skipped=%d total=%d",
        params.get("label"),
        ingested,
        skipped,
        total,
    )
    emit_wide_event()


# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------


_STAGING_FETCH_CONCURRENCY = 4
_STAGING_BATCH_SIZE = 50


async def _fetch_and_convert(
    entry: dict,
    *,
    vault_id: UUID,
    bucket: str,
    admin: R2Admin,
    config: dict,
    content_type: str,
    source_type: str,
    sem: asyncio.Semaphore,
) -> tuple[dict, str]:
    """Pull one staging blob, convert to markdown, prepend frontmatter."""
    async with sem:
        staging_key = f"staging/{vault_id}/{entry['hash']}"
        raw_bytes = await admin.fetch_bytes(bucket, staging_key)
        content = await _convert_to_markdown(
            raw_bytes, entry["name"], entry.get("mimetype", "")
        )
        content_with_fm = build_document(
            config, content, content_type, source_type=source_type
        )
        return entry, content_with_fm


async def _index_fetched_results(
    fetch_tasks: list[asyncio.Task[tuple[dict, str]]],
    *,
    ctx,
    vault_id: UUID,
    content_type: str,
    storage,
    existing_hashes: dict[str, str],
    doc_service: DocumentService,
) -> tuple[int, int, int, list[str]]:
    """Drain fetches as they complete, write+upsert in batches.

    Returns (ingested, skipped, failed, keys_to_clean). Each batch flush
    goes through ``DocumentService.batch_index_raw_docs``, which upserts,
    emits a compile intent, and commits in one transaction.
    """
    ingested = 0
    skipped = 0
    failed = 0
    batch: list[DocumentCreate] = []
    keys_to_clean: list[str] = []

    for i, coro in enumerate(asyncio.as_completed(fetch_tasks)):
        if i % 10 == 0:
            await ctx.heartbeat(600)
        try:
            entry, content_with_fm = await coro
        except Exception as e:
            log_event(
                "bulk_ingest_from_staging.fetch_failed",
                level=logging.WARNING,
                vault_id=str(vault_id),
                error_type=type(e).__name__,
                error=str(e),
            )
            failed += 1
            continue

        file_hash_val = file_hash(content_with_fm)
        dest = f"raw/{content_type}/{entry['hash'][:12]}.md"
        keys_to_clean.append(f"staging/{vault_id}/{entry['hash']}")

        if existing_hashes.get(dest) == file_hash_val:
            skipped += 1
            continue

        await storage.write(dest, content_with_fm)
        fm, _ = parse_frontmatter(content_with_fm)
        batch.append(DocumentCreate.from_frontmatter(fm, dest, content_with_fm))
        ingested += 1

        if len(batch) >= _STAGING_BATCH_SIZE:
            await doc_service.batch_index_raw_docs(vault_id, batch)
            batch.clear()

    if batch:
        await doc_service.batch_index_raw_docs(vault_id, batch)

    return ingested, skipped, failed, keys_to_clean


async def _cleanup_staging(
    admin: R2Admin, bucket: str, keys: list[str], *, vault_id: UUID
) -> None:
    """Best-effort delete of staging keys. Lifecycle rule (24h) is the
    safety net for any failures here."""
    if not keys:
        return
    results = await asyncio.gather(
        *(admin.delete_object(bucket, k) for k in keys),
        return_exceptions=True,
    )
    failures = sum(1 for r in results if isinstance(r, Exception))
    if failures:
        log_event(
            "bulk_ingest_from_staging.cleanup_failures",
            level=logging.WARNING,
            vault_id=str(vault_id),
            failed=failures,
            total=len(keys),
        )


async def bulk_ingest_from_staging_task(params: dict, ctx) -> None:
    """Process files previously uploaded to ``staging/<vault_id>/<hash>``.

    ``params`` shape:
        {
          "vault_id": str,
          "files": [{"hash": str, "name": str, "mimetype": str}, ...],
          "content_type": str,    # vault category, e.g. "texts"
          "source_type": str,     # frontmatter source_type, e.g. "document"
        }

    Idempotency comes from content-addressable dest paths
    (``raw/<content_type>/<hash[:12]>.md``) plus
    ``DocumentRepository.batch_upsert``'s ``(vault_id, file_path)``
    conflict target. Re-running the task on the same hashes is a no-op.
    """
    correlation_id.set(f"task-{ctx.task_id}")
    vault_id = UUID(params["vault_id"])
    files = params["files"]
    content_type = params["content_type"]
    source_type = params["source_type"]

    session = _task_session.get()
    vault = await VaultRepository(session).get_by_id(vault_id)
    if vault is None:
        raise ValueError(f"Vault {vault_id} not found")

    settings = get_settings()
    if settings.storage_backend != "r2":
        raise ValueError("bulk_ingest_from_staging requires r2 storage backend")
    if not vault.r2_bucket_name:
        raise ValueError(f"Vault {vault_id} has no r2_bucket_name")

    storage = make_storage(vault, settings)
    config = await load_config(storage)
    admin = R2Admin(
        account_id=settings.r2_account_id,
        access_key_id=settings.r2_access_key_id,
        secret_access_key=settings.r2_secret_access_key,
    )
    bucket = vault.r2_bucket_name

    init_wide_event(
        "bulk_ingest_from_staging", vault_id=str(vault_id), total=len(files)
    )
    await ctx.heartbeat(600)

    doc_service = DocumentService(DocumentRepository(session))
    existing_hashes = await doc_service.get_raw_file_hashes(vault_id)

    sem = asyncio.Semaphore(_STAGING_FETCH_CONCURRENCY)
    fetch_tasks = [
        asyncio.create_task(
            _fetch_and_convert(
                entry,
                vault_id=vault_id,
                bucket=bucket,
                admin=admin,
                config=config,
                content_type=content_type,
                source_type=source_type,
                sem=sem,
            )
        )
        for entry in files
    ]

    ingested, skipped, failed, keys_to_clean = await _index_fetched_results(
        fetch_tasks,
        ctx=ctx,
        vault_id=vault_id,
        content_type=content_type,
        storage=storage,
        existing_hashes=existing_hashes,
        doc_service=doc_service,
    )

    await _cleanup_staging(admin, bucket, keys_to_clean, vault_id=vault_id)

    enrich(ingested=ingested, skipped=skipped, failed=failed)
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
    app.register_task("bulk_ingest_from_staging", default_max_attempts=2)(
        bulk_ingest_from_staging_task
    )
    return app
