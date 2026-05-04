"""Task repository: database operations for TaskRecordORM."""

from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.core.tasks.models import TaskRecordORM
from great_minds.core.tasks.schemas import Task


class TaskRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def create(
        self, task_id: UUID, vault_id: UUID, task_type: str, params: dict
    ) -> Task:
        await self.session.execute(
            insert(TaskRecordORM)
            .values(
                id=task_id,
                vault_id=vault_id,
                type=task_type,
                params=params,
            )
            .on_conflict_do_nothing(index_elements=["id"])
        )
        record = await self.session.get(TaskRecordORM, task_id)
        if record is None:
            raise RuntimeError(f"TaskRecordORM {task_id} missing after upsert")
        return Task.model_validate(record)

    async def list_for_vault(
        self, vault_id: UUID, limit: int = 50, offset: int = 0
    ) -> list[Task]:
        rows = await self.session.execute(
            select(TaskRecordORM)
            .where(TaskRecordORM.vault_id == vault_id)
            .order_by(TaskRecordORM.created_at.desc())
            .offset(offset)
            .limit(limit)
        )
        return [Task.model_validate(r) for r in rows.scalars().all()]

    async def count_for_vault(self, vault_id: UUID) -> int:
        return (
            await self.session.scalar(
                select(func.count()).where(TaskRecordORM.vault_id == vault_id)
            )
        ) or 0

    async def get(self, task_id: UUID, vault_id: UUID) -> Task | None:
        row = await self.session.execute(
            select(TaskRecordORM).where(
                TaskRecordORM.id == task_id,
                TaskRecordORM.vault_id == vault_id,
            )
        )
        orm = row.scalar_one_or_none()
        return Task.model_validate(orm) if orm else None

    async def list_for_vault_by_type(
        self, vault_id: UUID, task_type: str, limit: int = 10
    ) -> list[Task]:
        """Most-recent-first list of tasks of a given type for a vault."""
        rows = await self.session.execute(
            select(TaskRecordORM)
            .where(
                TaskRecordORM.vault_id == vault_id,
                TaskRecordORM.type == task_type,
            )
            .order_by(TaskRecordORM.created_at.desc())
            .limit(limit)
        )
        return [Task.model_validate(r) for r in rows.scalars().all()]
