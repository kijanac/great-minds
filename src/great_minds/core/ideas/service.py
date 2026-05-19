"""IdeaService — thin orchestration over IdeaRepository.

Reads and writes both flow through the repository; the service layer
exists for consistency with the rest of ``core/*/service.py`` and to
give phases one DI handle for everything idea-related.
"""

from collections.abc import AsyncIterator, Iterable
from uuid import UUID

from great_minds.core.ideas.repository import IdeaRepository
from great_minds.core.ideas.schemas import Idea, IdeaCreate, IdeaOverview, SourceCard


class IdeaService:
    def __init__(self, *, repo: IdeaRepository) -> None:
        self.repo = repo

    async def record_extractions(self, entries: list[IdeaCreate]) -> None:
        await self.repo.bulk_upsert(entries)

    async def delete_for_documents(self, document_ids: Iterable[UUID]) -> None:
        await self.repo.delete_for_documents(document_ids)

    async def iter_overviews(
        self, vault_id: UUID, *, batch_size: int = 1024
    ) -> AsyncIterator[list[IdeaOverview]]:
        async for batch in self.repo.iter_overviews(vault_id, batch_size=batch_size):
            yield batch

    async def get_ids_for_vault(self, vault_id: UUID) -> list[UUID]:
        return await self.repo.get_ids_for_vault(vault_id)

    async def get_ideas_by_id(self, idea_ids: Iterable[UUID]) -> dict[UUID, Idea]:
        return await self.repo.get_ideas_by_id(idea_ids)

    async def iter_source_cards(self, vault_id: UUID) -> AsyncIterator[SourceCard]:
        async for card in self.repo.iter_source_cards(vault_id):
            yield card
