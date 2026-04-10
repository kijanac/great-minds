"""Task repository: database operations for TaskRecord."""

from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.core.tasks.models import TaskRecord


class TaskRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def create(
        self, task_id: UUID, brain_id: UUID, task_type: str, params: dict
    ) -> TaskRecord:
        await self.session.execute(
            insert(TaskRecord)
            .values(
                id=task_id,
                brain_id=brain_id,
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

    async def list_for_brain(
        self, brain_id: UUID, limit: int = 100
    ) -> list[TaskRecord]:
        rows = await self.session.execute(
            select(TaskRecord)
            .where(TaskRecord.brain_id == brain_id)
            .order_by(TaskRecord.created_at.desc())
            .limit(limit)
        )
        return list(rows.scalars().all())

    async def get(self, task_id: UUID, brain_id: UUID) -> TaskRecord | None:
        row = await self.session.execute(
            select(TaskRecord).where(
                TaskRecord.id == task_id,
                TaskRecord.brain_id == brain_id,
            )
        )
        return row.scalar_one_or_none()
