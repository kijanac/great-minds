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
Callers that want a summary (CLI, task worker) read wide_event
directly — no typed Result flows through.
"""

from great_minds.core.pipeline import (
    abstract,
    derive,
    extract,
    ingest,
    notify as pipeline_notify,
    publish,
    render,
    verify,
)
from great_minds.core.pipeline.context import PipelineContext, build_context
from great_minds.core.telemetry import log_event

__all__ = ["PipelineContext", "build_context", "run"]


async def run(ctx: PipelineContext) -> None:
    """Run all seven phases end-to-end.

    Each phase's cache-first semantics mean unchanged work is
    automatically skipped. Side effects (storage writes, DB rows) are
    the business outputs; per-phase counts accumulate in the wide
    event via enrich().

    Progress is pushed to the frontend via Postgres NOTIFY (when
    ctx.task_id is set), giving real-time per-phase visibility with
    zero polling.
    """
    tid = ctx.task_id

    # Phase 0 — ingest (mechanical, fast)
    await pipeline_notify.notify(task_id=tid, phase="ingest", status="started", total=1)
    await ingest.run(ctx)
    await pipeline_notify.notify(
        task_id=tid, phase="ingest", status="completed", done=1, total=1
    )

    # Phase 1 — extract (LLM-heavy, slow)
    await pipeline_notify.notify(task_id=tid, phase="extract", status="started")
    await extract.run(ctx)
    await pipeline_notify.notify(task_id=tid, phase="extract", status="completed")

    # Phase 2 — abstract
    await pipeline_notify.notify(
        task_id=tid, phase="abstract", status="started", total=1
    )
    validated = await abstract.run(ctx)
    if not validated:
        await pipeline_notify.notify(
            task_id=tid,
            phase="abstract",
            status="completed",
            done=1,
            total=1,
            early_exit=True,
        )
        log_event(
            "pipeline.compile_completed_early",
            vault_id=str(ctx.vault_id),
            reason="no_validated_topics",
        )
        return
    await pipeline_notify.notify(
        task_id=tid, phase="abstract", status="completed", done=1, total=1
    )

    # Phase 3 — derive (mechanical, fast)
    await pipeline_notify.notify(task_id=tid, phase="derive", status="started", total=1)
    await derive.run(ctx, validated)
    await pipeline_notify.notify(
        task_id=tid, phase="derive", status="completed", done=1, total=1
    )

    # Phase 4 — render (LLM-heavy, slow)
    await pipeline_notify.notify(task_id=tid, phase="render", status="started")
    await render.run(ctx, validated)
    await pipeline_notify.notify(task_id=tid, phase="render", status="completed")

    # Phase 5 — verify (mechanical, fast)
    await pipeline_notify.notify(task_id=tid, phase="verify", status="started", total=1)
    await verify.run(ctx)
    await pipeline_notify.notify(
        task_id=tid, phase="verify", status="completed", done=1, total=1
    )

    # Phase 6 — publish (mechanical, fast)
    await pipeline_notify.notify(
        task_id=tid, phase="publish", status="started", total=1
    )
    await publish.run(ctx)
    await pipeline_notify.notify(
        task_id=tid, phase="publish", status="completed", done=1, total=1
    )

    log_event("pipeline.compile_completed", vault_id=str(ctx.vault_id))
