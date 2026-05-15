"""Repository for ``ideas`` and ``anchors`` plus source-card reads.

Writes upsert ``ideas`` rows (one per extracted idea, embedding included)
and replace their ``anchors`` rows in one transaction. Reads come in
three flavors:

- Overview-shape (``list_for_vault`` / ``get_ids_for_vault``): used by
  partition for k-means clustering. Returns ``IdeaOverview`` — narrow
  projection of idea_id + embedding.
- Source-card-shape (``iter_source_cards``): used by partition /
  synthesize for vault-wide iteration with doc-level metadata attached.
- Idea-only-shape (``get_ideas_by_id``): used by render for spot-lookups
  by idea id. Doc metadata is resolved render-side from its own doc map.
"""

from collections.abc import AsyncIterator, Iterable
from uuid import UUID

from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from great_minds.core.documents.models import SourceDocumentORM
from great_minds.core.ideas.models import AnchorORM, IdeaORM
from great_minds.core.ideas.schemas import Idea, IdeaCreate, IdeaOverview, SourceCard


_MAX_BULK_UPSERT_ROWS = 1000


class IdeaRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def bulk_upsert(self, entries: list[IdeaCreate]) -> None:
        """Upsert ``ideas`` rows and replace their ``anchors`` rows.

        ``ideas`` upserts by ``idea_id``; label/description/embedding may
        change on a re-extraction that produces the same uuid. For
        anchors, the cascade-delete keyed on ``idea_id`` clears stale
        rows before insert, since order-as-identity makes update-in-place
        meaningless.
        """
        if not entries:
            return
        for start in range(0, len(entries), _MAX_BULK_UPSERT_ROWS):
            batch = entries[start : start + _MAX_BULK_UPSERT_ROWS]
            idea_values = [
                {
                    "idea_id": e.idea_id,
                    "vault_id": e.vault_id,
                    "document_id": e.document_id,
                    "kind": e.kind,
                    "label": e.label,
                    "description": e.description,
                    "embedding": e.embedding,
                }
                for e in batch
            ]
            idea_stmt = (
                insert(IdeaORM)
                .values(idea_values)
                .on_conflict_do_update(
                    index_elements=[IdeaORM.idea_id],
                    set_={
                        "label": insert(IdeaORM).excluded.label,
                        "description": insert(IdeaORM).excluded.description,
                        "embedding": insert(IdeaORM).excluded.embedding,
                    },
                )
            )
            await self.session.execute(idea_stmt)

            idea_ids = [e.idea_id for e in batch]
            await self.session.execute(
                delete(AnchorORM).where(AnchorORM.idea_id.in_(idea_ids))
            )

            anchor_values = [
                {
                    "idea_id": e.idea_id,
                    "position": i,
                    "claim": a.claim,
                    "quote": a.quote,
                    "chunk_index": a.chunk_index,
                }
                for e in batch
                for i, a in enumerate(e.anchors)
            ]
            if anchor_values:
                await self.session.execute(insert(AnchorORM).values(anchor_values))

    async def delete_for_documents(self, document_ids: Iterable[UUID]) -> None:
        """Delete ideas (and their anchors via cascade) for these documents.

        Used when extract re-runs on a cache-miss doc: the LLM minted
        fresh ``uuid7``s, so the prior idea rows for these docs are
        orphans and need to be cleared before the new ones are inserted.
        """
        ids = list(document_ids)
        if not ids:
            return
        await self.session.execute(delete(IdeaORM).where(IdeaORM.document_id.in_(ids)))

    async def list_for_vault(self, vault_id: UUID) -> list[IdeaOverview]:
        """Narrow read for partition's k-means: ``idea_id`` + ``embedding``.

        Ordered by ``idea_id`` so row order is deterministic across
        re-runs (KMeans tie-breaking depends on it). Returns the
        ``IdeaOverview`` projection — anchors aren't loaded, so this
        read is safe to call without a ``selectinload`` option.
        """
        rows = (
            await self.session.execute(
                select(IdeaORM.idea_id, IdeaORM.embedding)
                .where(IdeaORM.vault_id == vault_id)
                .order_by(IdeaORM.idea_id)
            )
        ).all()
        return [IdeaOverview.model_validate(row) for row in rows]

    async def get_ids_for_vault(self, vault_id: UUID) -> list[UUID]:
        rows = (
            (
                await self.session.execute(
                    select(IdeaORM.idea_id).where(IdeaORM.vault_id == vault_id)
                )
            )
            .scalars()
            .all()
        )
        return list(rows)

    async def get_ideas_by_id(self, idea_ids: Iterable[UUID]) -> dict[UUID, Idea]:
        """Spot-lookup ideas (with anchors) by id."""
        wanted = list(idea_ids)
        if not wanted:
            return {}
        rows = (
            (
                await self.session.execute(
                    select(IdeaORM)
                    .options(selectinload(IdeaORM.anchors))
                    .where(IdeaORM.idea_id.in_(wanted))
                )
            )
            .scalars()
            .all()
        )
        return {orm.idea_id: Idea.model_validate(orm) for orm in rows}

    async def iter_source_cards(self, vault_id: UUID) -> AsyncIterator[SourceCard]:
        """Yield one ``SourceCard`` per document that has been extracted.

        A document is "extracted" iff it has at least one row in
        ``ideas``. Docs that exist in ``source_documents`` but have no
        ideas (e.g. ingested but never compiled) are skipped, matching
        the prior JSONL semantics.
        """
        idea_rows = (
            (
                await self.session.execute(
                    select(IdeaORM)
                    .options(selectinload(IdeaORM.anchors))
                    .where(IdeaORM.vault_id == vault_id)
                )
            )
            .scalars()
            .all()
        )
        if not idea_rows:
            return

        ideas_by_doc: dict[UUID, list[Idea]] = {}
        for orm in idea_rows:
            ideas_by_doc.setdefault(orm.document_id, []).append(
                Idea.model_validate(orm)
            )

        doc_rows = (
            (
                await self.session.execute(
                    select(SourceDocumentORM).where(
                        SourceDocumentORM.id.in_(list(ideas_by_doc.keys()))
                    )
                )
            )
            .scalars()
            .all()
        )
        for doc in doc_rows:
            yield SourceCard(
                document_id=doc.id,
                title=doc.title,
                precis=doc.precis,
                author=doc.author,
                published_date=doc.published_date,
                genre=doc.genre,
                tags=doc.tags,
                derived_extras=doc.derived_extras,
                ideas=ideas_by_doc[doc.id],
            )
