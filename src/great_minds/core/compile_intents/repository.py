"""CompileIntent repository.

`ensure_pending` relies on the partial unique index
`ix_compile_intents_one_pending` to coalesce concurrent inserts: when a
pending intent already exists for the vault, ON CONFLICT DO NOTHING leaves
it alone, and the follow-up SELECT returns it.

`list_pending_locked` uses `FOR UPDATE SKIP LOCKED` so multiple
reconciler instances (future multi-process deployment) won't both try to
dispatch the same intent.
"""

from uuid import UUID

from sqlalchemy import select, text, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.core.compile_intents.models import CompileIntentRecord
from great_minds.core.compile_intents.schemas import CompileIntent


class CompileIntentRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def ensure_pending(
        self, vault_id: UUID, pipeline_run_id: UUID | None = None
    ) -> CompileIntent:
        """Return the vault's pending intent, inserting one if none exists.

        Single atomic statement: ``INSERT ... ON CONFLICT DO UPDATE`` against
        the partial unique index ``ix_compile_intents_one_pending``. On
        conflict the no-op ``SET vault_id = vault_id`` forces RETURNING to
        yield the conflicting (existing pending) row. PostgreSQL serializes
        concurrent dispatchers via the row lock, so the race that the
        two-statement form leaked is unrepresentable here. Caller commits.
        """
        stmt = (
            insert(CompileIntentRecord)
            .values(vault_id=vault_id, pipeline_run_id=pipeline_run_id)
            .on_conflict_do_update(
                index_elements=["vault_id"],
                index_where=text("dispatched_at IS NULL"),
                set_={"vault_id": CompileIntentRecord.vault_id},
            )
            .returning(CompileIntentRecord)
        )
        orm = (await self.session.execute(stmt)).scalar_one()
        return CompileIntent.model_validate(orm)

    async def list_pending_locked(self, limit: int = 100) -> list[CompileIntent]:
        """Pending intents, oldest first, locked with SKIP LOCKED."""
        rows = await self.session.execute(
            select(CompileIntentRecord)
            .where(CompileIntentRecord.dispatched_at.is_(None))
            .order_by(CompileIntentRecord.created_at)
            .limit(limit)
            .with_for_update(skip_locked=True)
        )
        return [CompileIntent.model_validate(o) for o in rows.scalars().all()]

    async def list_dispatched_unsatisfied(
        self, limit: int = 200
    ) -> list[CompileIntent]:
        rows = await self.session.execute(
            select(CompileIntentRecord)
            .where(
                CompileIntentRecord.dispatched_at.is_not(None),
                CompileIntentRecord.satisfied_at.is_(None),
            )
            .order_by(CompileIntentRecord.dispatched_at)
            .limit(limit)
        )
        return [CompileIntent.model_validate(o) for o in rows.scalars().all()]

    async def attach_pipeline_run(self, intent_id: UUID, pipeline_run_id: UUID) -> None:
        await self.session.execute(
            update(CompileIntentRecord)
            .where(CompileIntentRecord.id == intent_id)
            .values(pipeline_run_id=pipeline_run_id)
        )

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

    async def get(self, intent_id: UUID) -> CompileIntent | None:
        orm = await self.session.get(CompileIntentRecord, intent_id)
        return CompileIntent.model_validate(orm) if orm is not None else None
