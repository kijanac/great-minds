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
from great_minds.core.pipeline.abstract import partition, synthesize
from great_minds.core.pipeline.abstract.synthesize import SynthesizeResult
from great_minds.core.pipeline.context import PipelineContext
from great_minds.core.telemetry import log_event


async def run(ctx: PipelineContext) -> SynthesizeResult:
    """Phase 2 orchestrator. Returns synthesize's result for now.

    The real return shape will be list[ValidatedCanonicalTopic] once
    2c/2d/2e land — that's what phase 3 derive consumes. Intermediate
    partition/synthesize state stays internal to this orchestrator.
    """
    source_cards = SourceCardStore.for_brain(ctx.brain_id).load_all()

    partition_result = await partition.run(ctx, source_cards)
    if not partition_result.chunks:
        log_event(
            "pipeline.abstract_skipped",
            brain_id=str(ctx.brain_id),
            reason="no_chunks",
        )
        return SynthesizeResult()

    synthesize_result = await synthesize.run(
        ctx, source_cards, partition_result.chunks
    )

    log_event(
        "pipeline.abstract_completed",
        brain_id=str(ctx.brain_id),
        chunks=len(partition_result.chunks),
        local_topics=len(synthesize_result.local_topics),
    )
    return synthesize_result
