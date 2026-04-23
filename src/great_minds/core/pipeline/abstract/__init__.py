"""Phase 2 — abstract.

Five sub-steps:
  2a. partition    (mechanical)  — seeded k-means over idea embeddings
  2b. synthesize   (LLM)         — per-chunk local thematic topics
  2c. premerge     (mechanical)  — exact-match collapse of local topics
  2d. canonicalize (LLM)         — one call, canonical topic registry
  2e. validate     (mechanical)  — link_targets intersection, slug
                                   collision cleanup, archive flow

Only 2b and 2d draw from the LLM. This orchestrator owns the shared
state (source_cards loaded once, chunks passed through) and threads
each sub-step's output into the next. Returning composed results
rather than mutating a bag keeps each sub-phase's contract explicit.
"""

from __future__ import annotations

from great_minds.core.ideas.source_cards import SourceCardStore
from great_minds.core.pipeline.abstract import (
    canonicalize,
    partition,
    premerge,
    synthesize,
)
from great_minds.core.pipeline.abstract.canonicalize import CanonicalizeResult
from great_minds.core.pipeline.context import PipelineContext
from great_minds.core.settings import get_settings
from great_minds.core.telemetry import log_event


async def run(ctx: PipelineContext) -> CanonicalizeResult:
    """Phase 2 orchestrator. Returns canonicalize's result for now.

    The real return shape will be list[ValidatedCanonicalTopic] once
    2e validate lands — that's what phase 3 derive consumes.
    Intermediate partition/synthesize/premerge state stays local to
    the orchestrator.
    """
    settings = get_settings()
    source_cards = SourceCardStore.for_brain(ctx.brain_id).load_all()

    partition_result = await partition.run(ctx, source_cards)
    if not partition_result.chunks:
        log_event(
            "pipeline.abstract_skipped",
            brain_id=str(ctx.brain_id),
            reason="no_chunks",
        )
        return CanonicalizeResult()

    synthesize_result = await synthesize.run(
        ctx, source_cards, partition_result.chunks
    )
    premerge_result = premerge.run(
        synthesize_result.local_topics,
        jaccard_threshold=settings.compile_premerge_jaccard_threshold,
    )
    canonicalize_result = await canonicalize.run(
        ctx, premerge_result.merged_topics
    )

    log_event(
        "pipeline.abstract_completed",
        brain_id=str(ctx.brain_id),
        chunks=len(partition_result.chunks),
        local_topics=len(synthesize_result.local_topics),
        merged_topics=premerge_result.final_count,
        canonical_topics=len(canonicalize_result.canonical_topics),
    )
    return canonicalize_result
