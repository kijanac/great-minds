"""Seven-phase compile orchestrator.

Stages (named per target_architecture.md):
    0. ingest      — raw chunking into search_index (mechanical)
    1. extract     — per-doc LLM, ideas + anchors + doc metadata
    2. abstract    — partition, synthesize, premerge, canonicalize,
                     validate; produces the validated canonical topic
                     registry
    3. derive      — topic_membership, topic_links, topic_related
                     (mechanical tables from abstract's output)
    4. render      — per-topic LLM, wiki article body with anchor
                     footnotes + inter-topic links; rechunks wiki
                     files into search_index
    5. verify      — walks rendered articles, builds backlinks from
                     actual prose citations (mechanical)
    6. publish     — wiki/_index.md, raw/_index.md, compile log

Per-phase caching + DB persistence happens inside each phase. Phases
are side-effectful and emit counts into the wide event via enrich().

run() is the CLI entry point. The Absurd worker path (workers.py)
calls individual phases via ctx.step() for crash-resilient execution.
"""

from great_minds.core.pipeline import (
    abstract,
    derive,
    extract,
    ingest,
    publish,
    render,
    verify,
)
from great_minds.core.pipeline.context import PipelineContext, build_context
from great_minds.core.documents import DocumentRepository, DocumentService
from great_minds.core.search import SearchIndexRepository, SearchService
from great_minds.core.settings import get_settings
from great_minds.core.telemetry import log_event
from great_minds.core.topics.repository import TopicRepository
from great_minds.core.topics.service import TopicService

__all__ = ["PipelineContext", "build_context", "run"]


async def run(ctx: PipelineContext) -> None:
    """Run all seven phases end-to-end.

    Each phase's cache-first semantics mean unchanged work is
    automatically skipped. Side effects (storage writes, DB rows) are
    the business outputs; per-phase counts accumulate in the wide
    event via enrich().

    Progress is persisted to the pipeline run and pushed to the frontend
    via Postgres NOTIFY, giving resumable real-time per-phase visibility
    with zero polling.
    """
    run_id = ctx.pipeline_run_id

    # Phase 0 — ingest (mechanical, fast)
    await ctx.progress.emit(
        pipeline_run_id=run_id, phase="ingest", status="started", done=0, total=1
    )
    await ingest.IngestPhase(
        storage=ctx.storage,
        client=ctx.client,
        search=SearchService(SearchIndexRepository(ctx.session)),
    ).run(ctx.vault_id)
    await ctx.progress.emit(
        pipeline_run_id=run_id, phase="ingest", status="completed", done=1, total=1
    )

    # Phase 1 — extract (LLM-heavy, slow)
    await ctx.progress.emit(
        pipeline_run_id=run_id, phase="extract", status="started", done=0, total=0
    )
    await extract.run(ctx)
    await ctx.progress.emit(pipeline_run_id=run_id, phase="extract", status="completed")

    # Phase 2 — abstract
    await ctx.progress.emit(
        pipeline_run_id=run_id, phase="abstract", status="started", done=0, total=1
    )
    validated = await abstract.run(ctx)
    if not validated:
        await ctx.progress.emit(
            pipeline_run_id=run_id,
            phase="abstract",
            status="completed",
            done=1,
            total=1,
            message="no validated topics",
        )
        await ctx.progress.emit(
            pipeline_run_id=run_id,
            phase="publish",
            status="completed",
            done=1,
            total=1,
            message="compile completed early: no validated topics",
        )
        log_event(
            "pipeline.compile_completed_early",
            vault_id=str(ctx.vault_id),
            reason="no_validated_topics",
        )
        return
    await ctx.progress.emit(
        pipeline_run_id=run_id, phase="abstract", status="completed", done=1, total=1
    )

    # Phase 3 — derive (mechanical, fast)
    await ctx.progress.emit(
        pipeline_run_id=run_id, phase="derive", status="started", done=0, total=1
    )
    await derive.DerivePhase(
        topics=TopicService(TopicRepository(ctx.session)),
        related_limit=get_settings().compile_derive_related_limit,
    ).run(ctx.vault_id, validated)
    await ctx.progress.emit(
        pipeline_run_id=run_id, phase="derive", status="completed", done=1, total=1
    )

    # Phase 4 — render (LLM-heavy, slow)
    await ctx.progress.emit(
        pipeline_run_id=run_id, phase="render", status="started", done=0, total=0
    )
    await render.run(ctx, validated)
    await ctx.progress.emit(pipeline_run_id=run_id, phase="render", status="completed")

    # Phase 5 — verify (mechanical, fast)
    await ctx.progress.emit(
        pipeline_run_id=run_id, phase="verify", status="started", done=0, total=1
    )
    await verify.VerifyPhase(
        storage=ctx.storage,
        topics=TopicService(TopicRepository(ctx.session)),
        documents=DocumentService(DocumentRepository(ctx.session)),
    ).run(ctx.vault_id)
    await ctx.progress.emit(
        pipeline_run_id=run_id, phase="verify", status="completed", done=1, total=1
    )

    # Phase 6 — publish (mechanical, fast)
    await ctx.progress.emit(
        pipeline_run_id=run_id, phase="publish", status="started", done=0, total=1
    )
    await publish.PublishPhase(
        storage=ctx.storage,
        sidecar_root=ctx.sidecar_root,
        topics=TopicService(TopicRepository(ctx.session)),
        documents=DocumentService(DocumentRepository(ctx.session)),
        search=SearchService(SearchIndexRepository(ctx.session)),
    ).run(ctx.vault_id)
    await ctx.progress.emit(
        pipeline_run_id=run_id, phase="publish", status="completed", done=1, total=1
    )

    log_event("pipeline.compile_completed", vault_id=str(ctx.vault_id))
