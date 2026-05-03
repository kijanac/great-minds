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
    """
    await ingest.run(ctx)
    await extract.run(ctx)

    validated = await abstract.run(ctx)
    if not validated:
        log_event(
            "pipeline.compile_completed_early",
            vault_id=str(ctx.vault_id),
            reason="no_validated_topics",
        )
        return

    await derive.run(ctx, validated)
    await render.run(ctx, validated)
    await verify.run(ctx)
    await publish.run(ctx)

    log_event("pipeline.compile_completed", vault_id=str(ctx.vault_id))
