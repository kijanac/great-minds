"""Phase 3 — derive.

Mechanical, no LLM, no cache. Reads list[TopicDetail]
from phase 2 and rebuilds the three derived relational tables:

- topic_membership: (topic_id, idea_id) for each idea in each topic's
  resolved subsumed_idea_ids
- topic_links:      (source_topic_id, target_topic_id) edges from
  validated link_targets (slugs resolved to topic_ids)
- topic_related:    top-N related topics per topic, ranked by Jaccard
  over their idea sets; zero-overlap pairs skipped

Full replacement per compile — derived tables are cheap to rebuild
from the validated input and the mental model stays simple. compiled_
from_hash was already set by validate's upsert; no additional update
here.
"""

import logging

from great_minds.core.pipeline.context import PipelineContext
from great_minds.core.settings import get_settings
from great_minds.core.telemetry import enrich, log_event
from great_minds.core.topics.repository import TopicRepository
from great_minds.core.topics.schemas import TopicDetail
from great_minds.core.topics.service import TopicService

log = logging.getLogger(__name__)


async def run(
    ctx: PipelineContext,
    validated: list[TopicDetail],
) -> None:
    if not validated:
        log_event(
            "pipeline.derive_skipped",
            vault_id=str(ctx.vault_id),
            reason="no_topics",
        )
        return

    await TopicService(TopicRepository(ctx.session)).rebuild_derived_tables(
        ctx.vault_id,
        validated,
        related_limit=get_settings().compile_derive_related_limit,
    )

    enrich(derive_topic_count=len(validated))
    log_event(
        "pipeline.derive_completed",
        vault_id=str(ctx.vault_id),
        topic_count=len(validated),
    )
