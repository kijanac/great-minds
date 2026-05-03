"""IdeaService — coordinates source_cards.jsonl and idea_embeddings.

Extract writes to both stores; partition/map/derive read from one or
the other. The service is the single entry point so the two stores
stay aligned.
"""


from pathlib import Path
from uuid import UUID

from great_minds.core.ideas.repository import IdeaEmbeddingRepository
from great_minds.core.ideas.schemas import IdeaEmbedding, SourceCard
from great_minds.core.ideas.source_cards import SourceCardStore
from great_minds.core.paths import source_cards_path


class IdeaService:
    def __init__(
        self,
        *,
        vault_id: UUID,
        embedding_repo: IdeaEmbeddingRepository,
        sidecar_root: Path,
    ) -> None:
        self.vault_id = vault_id
        self.embedding_repo = embedding_repo
        self.source_cards = SourceCardStore(source_cards_path(sidecar_root))

    async def record_extractions(
        self,
        cards: list[SourceCard],
        embeddings: list[IdeaEmbedding],
    ) -> None:
        """Persist a batch of extractions. Caller is responsible for
        grouping cards + their embeddings together and committing the
        DB session at a sensible boundary.
        """
        self.source_cards.upsert_many(cards)
        await self.embedding_repo.bulk_upsert(embeddings)

    async def remove_document(self, document_id: UUID) -> None:
        self.source_cards.delete([document_id])
        await self.embedding_repo.delete_for_document(document_id)

    def load_source_cards(self) -> list[SourceCard]:
        return self.source_cards.load_all()

    async def list_embeddings(self) -> list[IdeaEmbedding]:
        return await self.embedding_repo.list_for_vault(self.vault_id)
