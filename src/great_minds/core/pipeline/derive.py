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

from great_minds.core.pipeline_runs import (
    PipelineProgressRunner,
    ProgressStepsMixin,
)
from great_minds.core.telemetry import enrich, log_event
from great_minds.core.topics.schemas import TopicDetail
from great_minds.core.topics.service import TopicService

log = logging.getLogger(__name__)

DERIVE_STEP_LABELS = {
    "find_related": "Connecting related topics",
}


class DerivePhase(ProgressStepsMixin):
    """Phase 3 runner with explicit service-style dependencies."""

    STEP_LABELS = DERIVE_STEP_LABELS

    def __init__(
        self,
        *,
        topics: TopicService,
        related_limit: int,
        progress: PipelineProgressRunner,
        pipeline_run_id: UUID,
    ) -> None:
        self.topics = topics
        self.related_limit = related_limit
        self.progress = progress
        self.pipeline_run_id = pipeline_run_id

    async def run(self, vault_id: UUID, validated: list[TopicDetail]) -> None:
        if not validated:
            log_event(
                "skipped",
                reason="no_topics",
            )
            await self.progress.emit(
                pipeline_run_id=self.pipeline_run_id,
                phase="derive",
                status="completed",
                steps=self.progress_steps(
                    "find_related", completed=set(DERIVE_STEP_LABELS)
                ),
            )
            return

        await self.progress.emit(
            pipeline_run_id=self.pipeline_run_id,
            phase="derive",
            status="progress",
            steps=self.progress_steps(
                "find_related",
                counts={"find_related": (0, len(validated))},
            ),
        )
        await self.topics.rebuild_derived_tables(
            vault_id,
            validated,
            related_limit=self.related_limit,
        )

        enrich(derive_topic_count=len(validated))
        log_event(
            "completed",
            topic_count=len(validated),
        )
        await self.progress.emit(
            pipeline_run_id=self.pipeline_run_id,
            phase="derive",
            status="completed",
            steps=self.progress_steps(
                "find_related",
                completed=set(DERIVE_STEP_LABELS),
                counts={"find_related": (len(validated), len(validated))},
            ),
        )
