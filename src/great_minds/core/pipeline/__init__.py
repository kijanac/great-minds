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
are side-effectful (write to storage + DB) and emit their own counts
via enrich() into the wide event. The orchestrator doesn't aggregate
per-phase Result objects; CompileResult is a slim view that the CLI
prints, populated from the wide event at the end.
"""

from __future__ import annotations

from dataclasses import dataclass

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
from great_minds.core.telemetry import log_event, wide_event

__all__ = ["CompileResult", "PipelineContext", "build_context", "run"]


@dataclass
class CompileResult:
    """Slim per-run summary for CLI/task callers.

    Populated from the wide event at run end. Per-phase detail lives in
    telemetry events.
    """

    raw_chunks_indexed: int = 0
    docs_extracted: int = 0
    docs_failed: int = 0
    topics: int = 0
    articles_rendered: int = 0
    articles_failed: int = 0
    wiki_chunks_indexed: int = 0
    backlink_edges: int = 0
    unresolved_citations: int = 0
    cost_usd: float = 0.0


async def run(ctx: PipelineContext) -> CompileResult:
    """Run all seven phases end-to-end.

    Each phase's cache-first semantics mean unchanged work is
    automatically skipped.
    """
    await ingest.run(ctx)
    await extract.run(ctx)

    validated = await abstract.run(ctx)
    if not validated:
        log_event(
            "pipeline.compile_completed_early",
            brain_id=str(ctx.brain_id),
            reason="no_validated_topics",
        )
        return _snapshot()

    await derive.run(ctx, validated)
    await render.run(ctx, validated)
    await verify.run(ctx)
    await publish.run(ctx)

    result = _snapshot()
    log_event(
        "pipeline.compile_completed",
        brain_id=str(ctx.brain_id),
        **result.__dict__,
    )
    return result


def _snapshot() -> CompileResult:
    """Read counts accumulated in the wide event into CompileResult."""
    ctx = wide_event.get() or {}
    return CompileResult(
        raw_chunks_indexed=ctx.get("raw_chunks_indexed", 0),
        docs_extracted=ctx.get("docs_extracted", 0),
        docs_failed=ctx.get("docs_failed", 0),
        topics=ctx.get("validated_topics", 0),
        articles_rendered=ctx.get("render_topics_rendered", 0),
        articles_failed=ctx.get("render_topics_failed", 0),
        wiki_chunks_indexed=ctx.get("render_wiki_chunks_indexed", 0),
        backlink_edges=ctx.get("verify_backlink_edges", 0),
        unresolved_citations=ctx.get("verify_unresolved_citations", 0),
        cost_usd=float(ctx.get("cost_usd", 0.0)),
    )
