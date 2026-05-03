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


from great_minds.core.ideas.source_cards import SourceCardStore
from great_minds.core.paths import source_cards_path
from great_minds.core.pipeline.abstract import (
    canonicalize,
    partition,
    premerge,
    synthesize,
    validate,
)
from great_minds.core.pipeline.abstract.schemas import ValidatedCanonicalTopic
from great_minds.core.pipeline.context import PipelineContext
from great_minds.core.settings import get_settings
from great_minds.core.telemetry import enrich, log_event


async def run(ctx: PipelineContext) -> list[ValidatedCanonicalTopic]:
    """Phase 2 orchestrator.

    Threads shared state (source_cards) through the sub-phases and
    returns what phase 3 derive consumes: a list of validated
    canonical topics with topic_ids resolved and link_targets cleaned.
    """
    settings = get_settings()
    source_cards = SourceCardStore(source_cards_path(ctx.sidecar_root)).load_all()

    chunks = await partition.run(ctx, source_cards)
    if not chunks:
        log_event(
            "pipeline.abstract_skipped",
            vault_id=str(ctx.vault_id),
            reason="no_chunks",
        )
        return []

    local_topics = await synthesize.run(ctx, source_cards, chunks)
    merged_topics = premerge.run(
        local_topics,
        jaccard_threshold=settings.compile_premerge_jaccard_threshold,
    )
    canonical_topics = await canonicalize.run(ctx, merged_topics)
    validated = await validate.run(ctx, canonical_topics, merged_topics)

    enrich(validated_topics=len(validated))
    log_event(
        "pipeline.abstract_completed",
        vault_id=str(ctx.vault_id),
        chunks=len(chunks),
        local_topics=len(local_topics),
        merged_topics=len(merged_topics),
        canonical_topics=len(canonical_topics),
        validated_topics=len(validated),
    )
    return validated
