"""Topic service — route-facing facade over TopicRepository.

Wiki routes and query tooling read through this. Pipeline phases use it
for topic-domain mutations so compile orchestration does not need to know
how derived topic tables are rebuilt.
"""

from collections.abc import Sequence
from uuid import UUID

from great_minds.core.topics.repository import TopicRepository
from great_minds.core.topics.schemas import (
    ArticleStatus,
    Topic,
    TopicDetail,
    TopicLink,
)


class TopicService:
    def __init__(self, repository: TopicRepository) -> None:
        self.repo = repository

    async def list_rendered(self, vault_id: UUID) -> list[Topic]:
        return await self.repo.list_by_status(vault_id, ArticleStatus.RENDERED)

    async def list_archived(self, vault_id: UUID) -> list[Topic]:
        return await self.repo.list_by_status(vault_id, ArticleStatus.ARCHIVED)

    async def count_all(self, vault_id: UUID) -> int:
        return await self.repo.count_all(vault_id)

    async def count_by_status(self, vault_id: UUID, status: ArticleStatus) -> int:
        return await self.repo.count_by_status(vault_id, status)

    async def count_dirty(self, vault_id: UUID) -> int:
        return await self.repo.count_dirty(vault_id)

    async def get_by_slug(self, vault_id: UUID, slug: str) -> Topic | None:
        return await self.repo.get_by_slug(vault_id, slug)

    async def get_by_id(self, topic_id: UUID) -> Topic | None:
        return await self.repo.get_by_id(topic_id)

    async def get_related(self, topic_id: UUID, limit: int = 20) -> list[Topic]:
        return await self.repo.get_related(topic_id, limit)

    async def list_links_for_vault(
        self, vault_id: UUID, source_topic_ids: list[UUID] | None = None
    ) -> list[TopicLink]:
        return await self.repo.list_links_for_vault(vault_id, source_topic_ids)

    async def rebuild_derived_tables(
        self,
        vault_id: UUID,
        topics: Sequence[TopicDetail],
        *,
        related_limit: int,
    ) -> None:
        """Replace membership, intended links, and related-topic rows.

        These tables are mechanical projections of the validated topic
        registry. They are replaced as a unit per compile so stale rows
        cannot survive topic merges, splits, or link-target changes.
        """
        await self._replace_membership(topics)
        await self._replace_links(vault_id, topics)
        await self._replace_related(topics, related_limit)

        await self.repo.session.commit()

    async def _replace_membership(self, topics: Sequence[TopicDetail]) -> None:
        for topic in topics:
            await self.repo.replace_membership(topic.topic_id, topic.subsumed_idea_ids)

    async def _replace_links(
        self,
        vault_id: UUID,
        topics: Sequence[TopicDetail],
    ) -> None:
        slug_to_id = {topic.slug: topic.topic_id for topic in topics}
        edges: list[tuple[UUID, UUID]] = []
        for topic in topics:
            for target_slug in topic.link_targets:
                target_id = slug_to_id.get(target_slug)
                if target_id is None or target_id == topic.topic_id:
                    continue
                edges.append((topic.topic_id, target_id))
        await self.repo.replace_links_for_vault(vault_id, edges)

    async def _replace_related(
        self,
        topics: Sequence[TopicDetail],
        limit: int,
    ) -> None:
        """Compute topic_related from topic_membership via SQL Jaccard."""
        topic_ids = [topic.topic_id for topic in topics]
        pairs = await self.repo.compute_pairwise_jaccard(topic_ids)

        # Fan out each pair into both directions.
        by_topic: dict[UUID, list[tuple[UUID, int, float]]] = {
            topic.topic_id: [] for topic in topics
        }
        for pair in pairs:
            by_topic[pair.topic_a].append((pair.topic_b, pair.shared, pair.jaccard))
            by_topic[pair.topic_b].append((pair.topic_a, pair.shared, pair.jaccard))

        for topic in topics:
            candidates = by_topic[topic.topic_id]
            # Deterministic: primary by jaccard desc, tie-break by topic_id.
            candidates.sort(key=lambda x: (-x[2], str(x[0])))
            await self.repo.replace_related(topic.topic_id, candidates[:limit])
