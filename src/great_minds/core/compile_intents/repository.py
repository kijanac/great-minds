"""CompileIntent repository.

`upsert_pending` relies on the partial unique index
`ix_compile_intents_one_pending` to coalesce concurrent inserts: when a
pending intent already exists for the vault, ON CONFLICT DO NOTHING
returns no row and the caller treats that as "already queued."

`list_pending_locked` uses `FOR UPDATE SKIP LOCKED` so multiple
reconciler instances (future multi-process deployment) won't both try to
dispatch the same intent.
"""

from uuid import UUID

from sqlalchemy import select, text, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.core.compile_intents.models import CompileIntentRecord


class CompileIntentRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def upsert_pending(self, vault_id: UUID) -> CompileIntentRecord | None:
        """Insert a pending intent, or return None if one already exists.

        Coalescing is enforced by the partial unique index. Caller must
        commit the surrounding transaction for the intent to be durable.
        """
        stmt = (
            insert(CompileIntentRecord)
            .values(vault_id=vault_id)
            .on_conflict_do_nothing(
                index_elements=["vault_id"],
                index_where=text("dispatched_at IS NULL"),
            )
            .returning(CompileIntentRecord)
        )
        row = await self.session.execute(stmt)
        return row.scalar_one_or_none()

    async def get_pending_for_vault(self, vault_id: UUID) -> CompileIntentRecord | None:
        row = await self.session.execute(
            select(CompileIntentRecord).where(
                CompileIntentRecord.vault_id == vault_id,
                CompileIntentRecord.dispatched_at.is_(None),
            )
        )
        return row.scalar_one_or_none()

    async def list_pending_locked(self, limit: int = 100) -> list[CompileIntentRecord]:
        """Pending intents, oldest first, locked with SKIP LOCKED."""
        rows = await self.session.execute(
            select(CompileIntentRecord)
            .where(CompileIntentRecord.dispatched_at.is_(None))
            .order_by(CompileIntentRecord.created_at)
            .limit(limit)
            .with_for_update(skip_locked=True)
        )
        return list(rows.scalars().all())

    async def list_dispatched_unsatisfied(
        self, limit: int = 200
    ) -> list[CompileIntentRecord]:
        rows = await self.session.execute(
            select(CompileIntentRecord)
            .where(
                CompileIntentRecord.dispatched_at.is_not(None),
                CompileIntentRecord.satisfied_at.is_(None),
            )
            .order_by(CompileIntentRecord.dispatched_at)
            .limit(limit)
        )
        return list(rows.scalars().all())

    async def mark_dispatched(self, intent_id: UUID, task_id: UUID) -> None:
        await self.session.execute(
            update(CompileIntentRecord)
            .where(CompileIntentRecord.id == intent_id)
            .values(dispatched_at=text("now()"), dispatched_task_id=task_id)
        )

    async def mark_satisfied(self, intent_id: UUID) -> None:
        await self.session.execute(
            update(CompileIntentRecord)
            .where(CompileIntentRecord.id == intent_id)
            .values(satisfied_at=text("now()"))
        )

    async def get(self, intent_id: UUID) -> CompileIntentRecord | None:
        return await self.session.get(CompileIntentRecord, intent_id)
