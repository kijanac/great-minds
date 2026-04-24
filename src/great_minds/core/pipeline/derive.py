"""Phase 3 — derive.

Mechanical, no LLM, no cache. Reads list[ValidatedCanonicalTopic]
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

from __future__ import annotations

import logging
from uuid import UUID

from great_minds.core.pipeline.abstract.schemas import ValidatedCanonicalTopic
from great_minds.core.pipeline.context import PipelineContext
from great_minds.core.settings import get_settings
from great_minds.core.telemetry import enrich, log_event
from great_minds.core.topics.repository import TopicRepository

log = logging.getLogger(__name__)


async def run(
    ctx: PipelineContext,
    validated: list[ValidatedCanonicalTopic],
) -> None:
    if not validated:
        log_event(
            "pipeline.derive_skipped",
            brain_id=str(ctx.brain_id),
            reason="no_topics",
        )
        return

    settings = get_settings()
    related_limit = settings.compile_derive_related_limit
    repo = TopicRepository(ctx.session)

    membership_rows = await _replace_membership(repo, validated)
    link_edges = await _replace_links(repo, ctx.brain_id, validated)
    related_rows = await _replace_related(repo, validated, related_limit)

    await ctx.session.commit()

    enrich(
        derive_topic_count=len(validated),
        derive_membership_rows=membership_rows,
        derive_link_edges=link_edges,
        derive_related_rows=related_rows,
    )
    log_event(
        "pipeline.derive_completed",
        brain_id=str(ctx.brain_id),
        topic_count=len(validated),
        membership_rows=membership_rows,
        link_edges=link_edges,
        related_rows=related_rows,
    )


async def _replace_membership(
    repo: TopicRepository, validated: list[ValidatedCanonicalTopic]
) -> int:
    total = 0
    for v in validated:
        await repo.replace_membership(v.topic_id, v.subsumed_idea_ids)
        total += len(v.subsumed_idea_ids)
    return total


async def _replace_links(
    repo: TopicRepository,
    brain_id: UUID,
    validated: list[ValidatedCanonicalTopic],
) -> int:
    slug_to_id = {v.slug: v.topic_id for v in validated}
    edges: list[tuple[UUID, UUID]] = []
    for v in validated:
        for target_slug in v.link_targets:
            target_id = slug_to_id.get(target_slug)
            if target_id is None or target_id == v.topic_id:
                continue
            edges.append((v.topic_id, target_id))
    await repo.replace_links_for_brain(brain_id, edges)
    return len(edges)


async def _replace_related(
    repo: TopicRepository,
    validated: list[ValidatedCanonicalTopic],
    limit: int,
) -> int:
    sets = {v.topic_id: set(v.subsumed_idea_ids) for v in validated}
    total = 0
    for v in validated:
        a = sets[v.topic_id]
        if not a:
            await repo.replace_related(v.topic_id, [])
            continue
        candidates: list[tuple[UUID, int, float]] = []
        for other in validated:
            if other.topic_id == v.topic_id:
                continue
            b = sets[other.topic_id]
            shared = len(a & b)
            if shared == 0:
                continue
            union = len(a | b) or 1
            jaccard = shared / union
            candidates.append((other.topic_id, shared, jaccard))
        # Deterministic: primary by jaccard desc, tie-break by topic_id.
        candidates.sort(key=lambda x: (-x[2], str(x[0])))
        top = candidates[:limit]
        await repo.replace_related(v.topic_id, top)
        total += len(top)
    return total
