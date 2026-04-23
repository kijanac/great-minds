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

Per-phase caching + DB persistence happens inside each phase; this
orchestrator threads shared inputs (validated topic set) and
aggregates a slim summary for CLI/task callers. Per-phase telemetry
is already emitted via the enrich/log_event pattern.
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
from great_minds.core.telemetry import log_event

__all__ = ["CompileResult", "PipelineContext", "build_context", "run"]


@dataclass
class CompileResult:
    """Slim per-run summary for CLI/task callers. Per-phase detail
    lives in telemetry events.
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


async def run(ctx: PipelineContext) -> CompileResult:
    """Run all seven phases end-to-end.

    Each phase's cache-first semantics mean unchanged work is
    automatically skipped. Per-phase telemetry already records skip
    counts; this orchestrator only needs to thread outputs.
    """
    result = CompileResult()

    ingest_result = await ingest.run(ctx)
    result.raw_chunks_indexed = ingest_result.raw_chunks_indexed

    extract_result = await extract.run(ctx)
    result.docs_extracted = extract_result.docs_extracted
    result.docs_failed = extract_result.docs_failed

    validated = await abstract.run(ctx)
    result.topics = len(validated)
    if not validated:
        log_event(
            "pipeline.compile_completed_early",
            brain_id=str(ctx.brain_id),
            reason="no_validated_topics",
            docs_extracted=result.docs_extracted,
        )
        return result

    await derive.run(ctx, validated)

    render_result = await render.run(ctx, validated)
    result.articles_rendered = render_result.topics_rendered
    result.articles_failed = render_result.topics_failed
    result.wiki_chunks_indexed = render_result.wiki_chunks_indexed

    verify_result = await verify.run(ctx)
    result.backlink_edges = verify_result.backlink_edges
    result.unresolved_citations = verify_result.unresolved_citations

    await publish.run(ctx)

    log_event(
        "pipeline.compile_completed",
        brain_id=str(ctx.brain_id),
        **result.__dict__,
    )
    return result
