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
from uuid import UUID

from great_minds.core.telemetry import enrich, log_event
from great_minds.core.topics.schemas import TopicDetail
from great_minds.core.topics.service import TopicService

log = logging.getLogger(__name__)


class DerivePhase:
    """Phase 3 runner with explicit service-style dependencies."""

    def __init__(
        self,
        *,
        topics: TopicService,
        related_limit: int,
    ) -> None:
        self.topics = topics
        self.related_limit = related_limit

    async def run(self, vault_id: UUID, validated: list[TopicDetail]) -> None:
        if not validated:
            log_event(
                "pipeline.derive_skipped",
                vault_id=str(vault_id),
                reason="no_topics",
            )
            return

        await self.topics.rebuild_derived_tables(
            vault_id,
            validated,
            related_limit=self.related_limit,
        )

        enrich(derive_topic_count=len(validated))
        log_event(
            "pipeline.derive_completed",
            vault_id=str(vault_id),
            topic_count=len(validated),
        )
