"""Topic service — route-facing facade over TopicRepository.

Wiki routes and query tooling read through this. Pipeline phases may
use it too but typically operate on the repository directly for bulk
operations.
"""


from uuid import UUID

from great_minds.core.topics.repository import TopicRepository
from great_minds.core.topics.schemas import ArticleStatus, RelatedTopic, Topic


class TopicService:
    def __init__(self, repository: TopicRepository) -> None:
        self.repo = repository

    async def list_rendered(self, vault_id: UUID) -> list[Topic]:
        return await self.repo.list_by_status(vault_id, ArticleStatus.RENDERED)

    async def list_archived(self, vault_id: UUID) -> list[Topic]:
        return await self.repo.list_by_status(vault_id, ArticleStatus.ARCHIVED)

    async def get_by_slug(self, vault_id: UUID, slug: str) -> Topic | None:
        return await self.repo.get_by_slug(vault_id, slug)

    async def get_by_id(self, topic_id: UUID) -> Topic | None:
        return await self.repo.get_by_id(topic_id)

    async def get_related(self, topic_id: UUID, limit: int = 20) -> list[RelatedTopic]:
        return await self.repo.get_related(topic_id, limit)
