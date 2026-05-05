"""Idea embeddings repository (Postgres, pgvector)."""

from uuid import UUID

from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.core.ideas.models import IdeaEmbeddingORM
from great_minds.core.ideas.schemas import IdeaEmbedding


class IdeaEmbeddingRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def bulk_upsert(self, entries: list[IdeaEmbedding]) -> None:
        """Upsert by idea_id. Label/description/embedding may update if a
        doc's re-extraction produces the same uuid5 with tweaked copy.
        """
        if not entries:
            return
        values = [
            {
                "idea_id": e.idea_id,
                "vault_id": e.vault_id,
                "document_id": e.document_id,
                "kind": e.kind,
                "label": e.label,
                "description": e.description,
                "embedding": e.embedding,
            }
            for e in entries
        ]
        stmt = (
            insert(IdeaEmbeddingORM)
            .values(values)
            .on_conflict_do_update(
                index_elements=[IdeaEmbeddingORM.idea_id],
                set_={
                    "label": insert(IdeaEmbeddingORM).excluded.label,
                    "description": insert(IdeaEmbeddingORM).excluded.description,
                    "embedding": insert(IdeaEmbeddingORM).excluded.embedding,
                },
            )
        )
        await self.session.execute(stmt)

    async def delete_for_document(self, document_id: UUID) -> None:
        await self.session.execute(
            delete(IdeaEmbeddingORM).where(IdeaEmbeddingORM.document_id == document_id)
        )

    async def delete_for_vault(self, vault_id: UUID) -> None:
        await self.session.execute(
            delete(IdeaEmbeddingORM).where(IdeaEmbeddingORM.vault_id == vault_id)
        )

    async def list_for_vault(self, vault_id: UUID) -> list[IdeaEmbedding]:
        rows = (
            (
                await self.session.execute(
                    select(IdeaEmbeddingORM).where(
                        IdeaEmbeddingORM.vault_id == vault_id
                    )
                )
            )
            .scalars()
            .all()
        )
        return [IdeaEmbedding.model_validate(row) for row in rows]

    async def get_ids_for_vault(self, vault_id: UUID) -> list[UUID]:
        rows = (
            (
                await self.session.execute(
                    select(IdeaEmbeddingORM.idea_id).where(
                        IdeaEmbeddingORM.vault_id == vault_id
                    )
                )
            )
            .scalars()
            .all()
        )
        return list(rows)
