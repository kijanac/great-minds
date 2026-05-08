"""Background task workers and absurd lifecycle.

Task functions run in a worker process and reconstruct their own
Storage/session from serialized params — they don't use the DI chain.
"""

import asyncio
import logging

import asyncpg
from contextvars import ContextVar
from uuid import UUID

from absurd_sdk import AbsurdHooks, AsyncAbsurd
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from great_minds.core.hashing import file_hash

from great_minds.core.pipeline import (
    abstract,
    build_context,
    derive,
    extract,
    ingest,
    publish,
    render,
    verify,
)
from great_minds.core.pipeline.steps import absurd_step_runner
from great_minds.core.topics.repository import TopicRepository
from great_minds.core.topics.schemas import TopicDetail
from great_minds.core.topics.service import TopicService
from great_minds.core.vaults.config import load_config
from great_minds.core.vaults.repository import VaultRepository
from great_minds.core.documents.builder import build_document
from great_minds.core.documents.repository import DocumentRepository
from great_minds.core.documents.schemas import DocumentCreate
from great_minds.core.documents.service import DocumentService
from great_minds.core.ideas.repository import IdeaEmbeddingRepository
from great_minds.core.ideas.service import IdeaService
from great_minds.core.ingest_service import _convert_to_markdown
from great_minds.core.llm import get_async_client
from great_minds.core.llm_costs import record_wide_event_cost
from great_minds.core.markdown import parse_frontmatter
from great_minds.core.r2_admin import R2Admin
from great_minds.core.search import SearchIndexRepository, SearchService
from great_minds.core.settings import get_settings
from great_minds.core.storage_factory import make_storage
from great_minds.core.pipeline_runs import PipelineProgressRunner
from great_minds.core.telemetry import (
    correlation_id,
    emit_wide_event,
    enrich,
    init_wide_event,
    log_event,
)

_task_session: ContextVar[AsyncSession] = ContextVar("task_session")
_task_session_maker: ContextVar[async_sessionmaker] = ContextVar("task_session_maker")

log = logging.getLogger(__name__)


async def _acquire_vault_compile_lock(
    *, vault_id: UUID, database_url: str
) -> asyncpg.Connection:
    """Hold a PostgreSQL session advisory lock for one vault compile.

    This is a hard correctness guard around vault-level compile outputs.
    The compile task may commit its normal SQLAlchemy session between
    phases, so the lock lives on a separate asyncpg connection for the
    duration of the task.
    """
    dsn = database_url.replace("+asyncpg", "")
    conn = await asyncpg.connect(dsn)
    try:
        await conn.execute(
            "SELECT pg_advisory_lock(hashtextextended($1, 0))",
            str(vault_id),
        )
    except Exception:
        await conn.close()
        raise
    return conn


async def _release_vault_compile_lock(
    conn: asyncpg.Connection | None, *, vault_id: UUID
) -> None:
    if conn is None:
        return
    try:
        await conn.execute(
            "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
            str(vault_id),
        )
    finally:
        await conn.close()


# ---------------------------------------------------------------------------
# Task functions
# ---------------------------------------------------------------------------


async def compile_task(params: dict, ctx) -> None:
    """Run the seven-phase compile pipeline as durable Absurd steps.

    Each phase is a `ctx.step()` — on worker crash, Absurd replays from
    the last completed checkpoint. Side effects (storage writes, DB
    upserts) are idempotent via content-addressing and ON CONFLICT.

    Telemetry (per-phase counters, cost, duration) is emitted via
    `emit_wide_event` for the structured-log pipeline; nothing is
    returned through the task result.
    """
    correlation_id.set(f"task-{ctx.task_id}")
    vault_id = UUID(params["vault_id"])
    pipeline_run_id = UUID(params["pipeline_run_id"])
    session = _task_session.get()
    progress = PipelineProgressRunner(_task_session_maker.get())
    settings = get_settings()
    compile_lock_conn: asyncpg.Connection | None = None
    vault = await VaultRepository(session).get_by_id(vault_id)
    if vault is None:
        raise ValueError(f"Vault {vault_id} not found")
    storage = make_storage(vault)
    client = get_async_client()

    init_wide_event("compile", vault_id=str(vault_id))

    # Background heartbeat — extends the Absurd task lease every
    # half the claim_timeout (60s of 120s), so long-running phases
    # (ingest on 3000 docs, extract) don't trigger $ClaimTimeout.
    async def _heartbeat_loop():
        while True:
            await asyncio.sleep(60)
            await ctx.heartbeat(120)

    hb_task = asyncio.create_task(_heartbeat_loop())

    try:
        log_event(
            "compile_lock_waiting",
            vault_id=str(vault_id),
            pipeline_run_id=str(pipeline_run_id),
        )
        compile_lock_conn = await _acquire_vault_compile_lock(
            vault_id=vault_id,
            database_url=settings.database_url,
        )
        log_event(
            "compile_lock_acquired",
            vault_id=str(vault_id),
            pipeline_run_id=str(pipeline_run_id),
        )

        pipeline_ctx = await build_context(
            vault_id=vault_id,
            pipeline_run_id=pipeline_run_id,
            progress=progress,
            storage=storage,
            session=session,
            client=client,
            steps=absurd_step_runner(ctx),
        )

        # Phase 0 — mechanical chunking + embedding of raw docs
        async def _run_ingest():
            await progress.emit(
                pipeline_run_id=pipeline_run_id,
                phase="ingest",
                status="started",
                done=0,
                total=1,
            )
            await ingest.IngestPhase(
                storage=pipeline_ctx.storage,
                client=pipeline_ctx.client,
                search=SearchService(SearchIndexRepository(pipeline_ctx.session)),
            ).run(pipeline_ctx.vault_id)
            await progress.emit(
                pipeline_run_id=pipeline_run_id,
                phase="ingest",
                status="completed",
                done=1,
                total=1,
            )

        await ctx.step("phase-ingest", _run_ingest)

        # Phase 1 — per-doc LLM extraction (ideas, anchors, metadata)
        async def _run_extract():
            await progress.emit(
                pipeline_run_id=pipeline_run_id,
                phase="extract",
                status="started",
                done=0,
                total=0,
            )
            await extract.ExtractPhase(
                storage=pipeline_ctx.storage,
                client=pipeline_ctx.client,
                session=pipeline_ctx.session,
                progress=progress,
                compile_cache=pipeline_ctx.compile_cache,
                documents=DocumentService(DocumentRepository(pipeline_ctx.session)),
                ideas=IdeaService(
                    embedding_repo=IdeaEmbeddingRepository(pipeline_ctx.session),
                    sidecar_root=pipeline_ctx.sidecar_root,
                ),
                config=pipeline_ctx.config,
                concurrency=settings.compile_enrich_concurrency,
            ).run(pipeline_ctx.vault_id, pipeline_run_id)
            await progress.emit(
                pipeline_run_id=pipeline_run_id,
                phase="extract",
                status="completed",
            )

        await ctx.step("phase-extract", _run_extract)

        # Phase 2 — topic clustering, synthesis, canonicalization
        async def _run_abstract():
            await progress.emit(
                pipeline_run_id=pipeline_run_id,
                phase="abstract",
                status="started",
                done=0,
                total=1,
            )
            result = await abstract.run(pipeline_ctx)
            if not result:
                await progress.emit(
                    pipeline_run_id=pipeline_run_id,
                    phase="abstract",
                    status="completed",
                    done=1,
                    total=1,
                    message="no validated topics",
                )
            else:
                await progress.emit(
                    pipeline_run_id=pipeline_run_id,
                    phase="abstract",
                    status="completed",
                    done=1,
                    total=1,
                )
            return [v.model_dump(mode="json") for v in result]

        validated_raw = await ctx.step("phase-abstract", _run_abstract)
        if not validated_raw:
            # No topics — pipeline completed early
            await record_wide_event_cost(session, user_id=None, vault_id=vault_id)
            await session.commit()
            return
        validated = [TopicDetail.model_validate(v) for v in validated_raw]

        # Phase 3 — mechanical: topic_membership, topic_links, topic_related
        async def _run_derive():
            await progress.emit(
                pipeline_run_id=pipeline_run_id,
                phase="derive",
                status="started",
                done=0,
                total=1,
            )
            await derive.DerivePhase(
                topics=TopicService(TopicRepository(pipeline_ctx.session)),
                related_limit=get_settings().compile_derive_related_limit,
            ).run(pipeline_ctx.vault_id, validated)
            await progress.emit(
                pipeline_run_id=pipeline_run_id,
                phase="derive",
                status="completed",
                done=1,
                total=1,
            )

        await ctx.step("phase-derive", _run_derive)

        # Phase 4 — per-topic LLM article generation
        async def _run_render():
            await progress.emit(
                pipeline_run_id=pipeline_run_id,
                phase="render",
                status="started",
                done=0,
                total=0,
            )
            await render.RenderPhase(
                storage=pipeline_ctx.storage,
                client=pipeline_ctx.client,
                session=pipeline_ctx.session,
                progress=progress,
                compile_cache=pipeline_ctx.compile_cache,
                steps=pipeline_ctx.steps,
                documents=DocumentService(DocumentRepository(pipeline_ctx.session)),
                topics=TopicService(TopicRepository(pipeline_ctx.session)),
                search=SearchService(SearchIndexRepository(pipeline_ctx.session)),
                sidecar_root=pipeline_ctx.sidecar_root,
                concurrency=settings.compile_write_concurrency,
            ).run(pipeline_ctx.vault_id, pipeline_run_id, validated)
            await progress.emit(
                pipeline_run_id=pipeline_run_id,
                phase="render",
                status="completed",
            )

        await ctx.step("phase-render", _run_render)

        # Phase 5 — mechanical: backlinks, citation verification
        async def _run_verify():
            await progress.emit(
                pipeline_run_id=pipeline_run_id,
                phase="verify",
                status="started",
                done=0,
                total=1,
            )
            await verify.VerifyPhase(
                storage=pipeline_ctx.storage,
                topics=TopicService(TopicRepository(pipeline_ctx.session)),
                documents=DocumentService(DocumentRepository(pipeline_ctx.session)),
            ).run(pipeline_ctx.vault_id)
            await progress.emit(
                pipeline_run_id=pipeline_run_id,
                phase="verify",
                status="completed",
                done=1,
                total=1,
            )

        await ctx.step("phase-verify", _run_verify)

        # Phase 6 — mechanical: index files + compile log
        async def _run_publish():
            await progress.emit(
                pipeline_run_id=pipeline_run_id,
                phase="publish",
                status="started",
                done=0,
                total=1,
            )
            await publish.PublishPhase(
                storage=pipeline_ctx.storage,
                sidecar_root=pipeline_ctx.sidecar_root,
                topics=TopicService(TopicRepository(pipeline_ctx.session)),
                documents=DocumentService(DocumentRepository(pipeline_ctx.session)),
                search=SearchService(SearchIndexRepository(pipeline_ctx.session)),
            ).run(pipeline_ctx.vault_id)
            await progress.emit(
                pipeline_run_id=pipeline_run_id,
                phase="publish",
                status="completed",
                done=1,
                total=1,
            )

        await ctx.step("phase-publish", _run_publish)

        log_event("pipeline.compile_completed", vault_id=str(pipeline_ctx.vault_id))
        await record_wide_event_cost(session, user_id=None, vault_id=vault_id)
        await session.commit()
    except Exception as exc:
        await progress.fail(pipeline_run_id, str(exc))
        raise
    finally:
        await _release_vault_compile_lock(compile_lock_conn, vault_id=vault_id)
        hb_task.cancel()
        try:
            await hb_task
        except asyncio.CancelledError:
            pass
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
    name = entry["name"]
    log.debug(
        "fetch_convert start name=%s sem_waiters=%d",
        name,
        sem._waiters if hasattr(sem, "_waiters") else -1,
    )
    t0 = asyncio.get_event_loop().time()
    async with sem:
        staging_key = f"staging/{vault_id}/{entry['hash']}"
        raw_bytes = await asyncio.to_thread(admin.fetch_bytes, bucket, staging_key)
        content = await _convert_to_markdown(raw_bytes, name, entry.get("mimetype", ""))
        content_with_fm = build_document(
            config, content, content_type, source_type=source_type
        )
        elapsed = asyncio.get_event_loop().time() - t0
        log.debug("fetch_convert done name=%s elapsed=%.2fs", name, elapsed)
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
    progress: PipelineProgressRunner,
    pipeline_run_id: UUID,
) -> tuple[int, int, int, list[str]]:
    """Drain fetches as they complete, write+upsert in batches.

    Returns (ingested, skipped, failed, keys_to_clean). Each batch flush
    goes through ``DocumentService.batch_index_raw_docs``, which upserts
    and commits without emitting compile intents; the caller emits one
    intent after the full staged upload is indexed.
    """
    ingested = 0
    skipped = 0
    failed = 0
    batch: list[DocumentCreate] = []
    keys_to_clean: list[str] = []
    seen_dest: set[str] = set()  # dedupe within this run for batch_upsert
    failed_names: list[str] = []

    pending = len(fetch_tasks)
    for i, coro in enumerate(asyncio.as_completed(fetch_tasks)):
        if i % 10 == 0:
            await ctx.heartbeat(600)
        if i > 0 and i % 100 == 0:
            remaining = pending - i
            log.info(
                "staged_file_ingest drain: %d/%d completed %d failed %d pending",
                i,
                pending,
                failed,
                remaining,
            )
        try:
            entry, content_with_fm = await coro
        except Exception as e:
            log_event(
                "staged_file_ingest.fetch_failed",
                level=logging.WARNING,
                vault_id=str(vault_id),
                error_type=type(e).__name__,
                error=str(e),
                file_name=entry.get("name", "?"),
            )
            failed += 1
            failed_names.append(entry.get("name", "?"))
            continue

        file_hash_val = file_hash(content_with_fm)
        dest = f"raw/{content_type}/{entry['hash'][:12]}.md"
        keys_to_clean.append(f"staging/{vault_id}/{entry['hash']}")

        if existing_hashes.get(dest) == file_hash_val or dest in seen_dest:
            skipped += 1
            continue

        await storage.write(dest, content_with_fm)
        seen_dest.add(dest)
        fm, _ = parse_frontmatter(content_with_fm)
        batch.append(DocumentCreate.from_frontmatter(fm, dest, content_with_fm))
        ingested += 1

        if len(batch) >= _STAGING_BATCH_SIZE:
            log.debug(
                "batch_upsert start batch_size=%d ingest_count=%d", len(batch), ingested
            )
            await doc_service.batch_index_raw_docs(vault_id, batch)
            log.debug("batch_upsert done")
            batch.clear()
            done = ingested + skipped
            await progress.emit(
                pipeline_run_id=pipeline_run_id,
                phase="source_ingest",
                status="progress",
                done=done,
                total=pending,
                failed=failed,
                message="processing uploaded sources",
            )

    if batch:
        log.debug(
            "batch_upsert final batch_size=%d ingest_count=%d", len(batch), ingested
        )
        await doc_service.batch_index_raw_docs(vault_id, batch)
        log.debug("batch_upsert final done")

    done = ingested + skipped
    await progress.emit(
        pipeline_run_id=pipeline_run_id,
        phase="source_ingest",
        status="progress",
        done=done,
        total=pending,
        failed=failed,
        message="processing uploaded sources",
    )

    return ingested, skipped, failed, keys_to_clean


async def _cleanup_staging(
    admin: R2Admin, bucket: str, keys: list[str], *, vault_id: UUID
) -> None:
    """Best-effort delete of staging keys. Lifecycle rule (24h) is the
    safety net for any failures here."""
    if not keys:
        return
    results = await asyncio.gather(
        *(asyncio.to_thread(admin.delete_object, bucket, k) for k in keys),
        return_exceptions=True,
    )
    failures = sum(1 for r in results if isinstance(r, Exception))
    if failures:
        log_event(
            "staged_file_ingest.cleanup_failures",
            level=logging.WARNING,
            vault_id=str(vault_id),
            failed=failures,
            total=len(keys),
        )


async def staged_file_ingest_task(params: dict, ctx) -> None:
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
    pipeline_run_id = UUID(params["pipeline_run_id"])
    progress = PipelineProgressRunner(_task_session_maker.get())

    try:
        session = _task_session.get()
        vault = await VaultRepository(session).get_by_id(vault_id)
        if vault is None:
            raise ValueError(f"Vault {vault_id} not found")

        settings = get_settings()
        if settings.storage_backend != "r2":
            raise ValueError("staged_file_ingest requires r2 storage backend")
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

        init_wide_event("staged_file_ingest", vault_id=str(vault_id), total=len(files))
        await ctx.heartbeat(600)

        doc_service = DocumentService(
            DocumentRepository(session), pipeline_run_id=pipeline_run_id
        )
        existing_hashes = await doc_service.get_raw_file_hashes(vault_id)
        await progress.emit(
            pipeline_run_id=pipeline_run_id,
            phase="source_ingest",
            status="started",
            done=0,
            total=len(files),
            message="processing uploaded sources",
        )

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

        # Liveness timer — fires even if asyncio.as_completed() stalls
        alive = True

        async def liveness_log():
            while alive:
                done = sum(1 for t in fetch_tasks if t.done())
                pending = len(fetch_tasks) - done
                log.info(
                    "staged_file_ingest liveness: %d/%d done %d pending %d failed so far",
                    done,
                    len(fetch_tasks),
                    pending,
                    0,
                )
                await asyncio.sleep(10)

        liveness_task = asyncio.create_task(liveness_log())
        try:
            ingested, skipped, failed, keys_to_clean = await _index_fetched_results(
                fetch_tasks,
                ctx=ctx,
                vault_id=vault_id,
                content_type=content_type,
                storage=storage,
                existing_hashes=existing_hashes,
                doc_service=doc_service,
                progress=progress,
                pipeline_run_id=pipeline_run_id,
            )
        finally:
            alive = False
            liveness_task.cancel()
            try:
                await liveness_task
            except asyncio.CancelledError:
                pass

        await _cleanup_staging(admin, bucket, keys_to_clean, vault_id=vault_id)

        if ingested > 0:
            await doc_service.emit_compile_intent(vault_id)
            await session.commit()

        await progress.emit(
            pipeline_run_id=pipeline_run_id,
            phase="source_ingest",
            status="completed",
            done=ingested + skipped,
            total=len(files),
            failed=failed,
            message="sources prepared for compile",
        )
        if ingested == 0:
            if failed > 0:
                await progress.emit(
                    pipeline_run_id=pipeline_run_id,
                    phase="source_ingest",
                    status="failed",
                    failed=failed,
                    error=f"{failed} source(s) failed before compile",
                )
            else:
                await progress.emit(
                    pipeline_run_id=pipeline_run_id,
                    phase="publish",
                    status="completed",
                    done=1,
                    total=1,
                    message="sources already up to date",
                )

        enrich(ingested=ingested, skipped=skipped, failed=failed)
        emit_wide_event()
    except Exception as exc:
        await progress.emit(
            pipeline_run_id=pipeline_run_id,
            phase="source_ingest",
            status="failed",
            error=str(exc),
        )
        raise


# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------


def create_absurd(database_url: str, session_maker: async_sessionmaker) -> AsyncAbsurd:
    """Create and configure an AsyncAbsurd instance with all tasks registered."""
    url = database_url.replace("+asyncpg", "")

    async def wrap_with_session(ctx, execute):
        async with session_maker() as session:
            session_token = _task_session.set(session)
            sm_token = _task_session_maker.set(session_maker)
            try:
                return await execute()
            finally:
                _task_session_maker.reset(sm_token)
                _task_session.reset(session_token)

    hooks = AbsurdHooks(wrap_task_execution=wrap_with_session)
    app = AsyncAbsurd(url, queue_name="default", hooks=hooks)
    app.register_task("compile", default_max_attempts=3)(compile_task)
    app.register_task("staged_file_ingest", default_max_attempts=2)(
        staged_file_ingest_task
    )
    return app
