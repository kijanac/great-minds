"""Task repository: database operations for TaskRecord."""

from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.core.tasks.models import TaskRecord


class TaskRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def create(
        self, task_id: UUID, vault_id: UUID, task_type: str, params: dict
    ) -> TaskRecord:
        await self.session.execute(
            insert(TaskRecord)
            .values(
                id=task_id,
                vault_id=vault_id,
                type=task_type,
                params=params,
                created_at=datetime.now(UTC),
            )
            .on_conflict_do_nothing(index_elements=["id"])
        )
        record = await self.session.get(TaskRecord, task_id)
        if record is None:
            raise RuntimeError(f"TaskRecord {task_id} missing after upsert")
        return record

    async def list_for_vault(
        self, vault_id: UUID, limit: int = 50, offset: int = 0
    ) -> list[TaskRecord]:
        rows = await self.session.execute(
            select(TaskRecord)
            .where(TaskRecord.vault_id == vault_id)
            .order_by(TaskRecord.created_at.desc())
            .offset(offset)
            .limit(limit)
        )
        return list(rows.scalars().all())

    async def count_for_vault(self, vault_id: UUID) -> int:
        return (
            await self.session.scalar(
                select(func.count()).where(TaskRecord.vault_id == vault_id)
            )
        ) or 0

    async def get(self, task_id: UUID, vault_id: UUID) -> TaskRecord | None:
        row = await self.session.execute(
            select(TaskRecord).where(
                TaskRecord.id == task_id,
                TaskRecord.vault_id == vault_id,
            )
        )
        return row.scalar_one_or_none()

    async def list_for_vault_by_type(
        self, vault_id: UUID, task_type: str, limit: int = 10
    ) -> list[TaskRecord]:
        """Most-recent-first list of tasks of a given type for a vault."""
        rows = await self.session.execute(
            select(TaskRecord)
            .where(
                TaskRecord.vault_id == vault_id,
                TaskRecord.type == task_type,
            )
            .order_by(TaskRecord.created_at.desc())
            .limit(limit)
        )
        return list(rows.scalars().all())
