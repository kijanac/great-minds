"""Repository for ``ideas`` and ``anchors`` plus source-card reads.

Writes upsert ``ideas`` rows (one per extracted idea, embedding included)
and replace their ``anchors`` rows in one transaction. Reads come in
three flavors:

- Overview-shape (``iter_overviews`` / ``get_ids_for_vault``): used by
  partition for k-means clustering. ``iter_overviews`` keyset-paginates
  to keep peak memory bounded by batch size; ``get_ids_for_vault`` is a
  narrow id-only read for cache-key computation.
- Source-card-shape (``iter_source_cards``): used by partition /
  synthesize for vault-wide iteration with doc-level metadata attached.
  Anchors deliberately not loaded — neither caller reads them.
- Idea-only-shape (``get_ideas_by_id``): used by render for spot-lookups
  by idea id. Doc metadata is resolved render-side from its own doc map.
  Selectinloads anchors because render builds footnoted articles from
  claim/quote pairs.
"""

import logging
from collections.abc import AsyncIterator, Iterable
from uuid import UUID

from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from great_minds.core.documents.models import SourceDocumentORM
from great_minds.core.ideas.models import AnchorORM, IdeaORM
from great_minds.core.ideas.schemas import Idea, IdeaCreate, IdeaOverview, SourceCard
from great_minds.core.telemetry import log_event


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

            # Diagnostic: surface duplicate idea_ids within a batch BEFORE the
            # INSERT. ``ON CONFLICT DO UPDATE`` rejects batches with repeated
            # conflict-targets ("cannot affect row a second time"). Logging
            # the duplicates plus their contributing document_ids tells us
            # whether the dup is intra-doc (one doc's source_card has two
            # ideas with the same id — points at cache corruption or a
            # validator bug) or cross-doc (cache aliasing across same-body
            # documents).
            by_id: dict[UUID, list[UUID]] = {}
            for e in batch:
                by_id.setdefault(e.idea_id, []).append(e.document_id)
            duplicates = {iid: docs for iid, docs in by_id.items() if len(docs) > 1}
            if duplicates:
                log_event(
                    "bulk_upsert.duplicate_idea_ids",
                    level=logging.WARNING,
                    batch_start=start,
                    batch_size=len(batch),
                    duplicate_count=len(duplicates),
                    duplicates={
                        str(iid): [str(d) for d in docs]
                        for iid, docs in duplicates.items()
                    },
                )

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

    async def iter_overviews(
        self, vault_id: UUID, *, batch_size: int = 1024
    ) -> AsyncIterator[list[IdeaOverview]]:
        """Stream ``IdeaOverview`` batches for partition's k-means.

        Keyset pagination over ``idea_id`` (already the PK / indexed) so
        peak memory is bounded by ``batch_size × embedding_dim`` rather
        than the full corpus. Stable order across passes — multiple
        epochs of ``partial_fit`` see the same idea sequence.
        """
        last_seen: UUID | None = None
        while True:
            stmt = select(IdeaORM.idea_id, IdeaORM.embedding).where(
                IdeaORM.vault_id == vault_id
            )
            if last_seen is not None:
                stmt = stmt.where(IdeaORM.idea_id > last_seen)
            stmt = stmt.order_by(IdeaORM.idea_id).limit(batch_size)
            rows = (await self.session.execute(stmt)).all()
            if not rows:
                return
            batch = [IdeaOverview.model_validate(r) for r in rows]
            yield batch
            last_seen = batch[-1].idea_id

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

        Anchors are *not* loaded — the two callers (partition's token
        estimate, synthesize's index build) only read idea metadata.
        Render needs anchors and uses ``get_ideas_by_id`` instead, which
        keeps its own ``selectinload``. Skipping the selectinload here
        avoids materializing all anchor rows into Python objects.
        """
        idea_rows = (
            (
                await self.session.execute(
                    select(IdeaORM).where(IdeaORM.vault_id == vault_id)
                )
            )
            .scalars()
            .all()
        )
        if not idea_rows:
            return

        # Construct Idea explicitly with anchors=[]: callers of this
        # iterator (partition's token estimate, synthesize's index build)
        # don't read anchors, and going through ``Idea.model_validate``
        # on a non-selectinload'd ORM would trigger a lazy load of the
        # anchors relationship from inside an async session — which
        # blows up with MissingGreenlet. Render needs anchors and uses
        # ``get_ideas_by_id`` which keeps its own selectinload.
        ideas_by_doc: dict[UUID, list[Idea]] = {}
        for orm in idea_rows:
            ideas_by_doc.setdefault(orm.document_id, []).append(
                Idea(
                    idea_id=orm.idea_id,
                    document_id=orm.document_id,
                    kind=orm.kind,
                    label=orm.label,
                    description=orm.description,
                    anchors=[],
                )
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
