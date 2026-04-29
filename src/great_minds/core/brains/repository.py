"""Brain repository: database operations."""

from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.core.brains.models import (
    BrainORM,
    BrainMembership,
    MemberRole,
)
from great_minds.core.brains.schemas import Brain
from great_minds.core.users.models import User


class BrainRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get_by_id(self, brain_id: UUID) -> Brain | None:
        result = await self.session.execute(
            select(BrainORM).where(BrainORM.id == brain_id)
        )
        row = result.scalar_one_or_none()
        return Brain.model_validate(row) if row else None

    async def create_brain(self, name: str, owner_id: UUID) -> tuple[Brain, MemberRole]:
        brain = BrainORM(
            name=name,
            owner_id=owner_id,
        )
        self.session.add(brain)
        await self.session.flush()
        await self.upsert_membership(brain.id, owner_id, MemberRole.OWNER)
        await self.session.refresh(brain)
        return Brain.model_validate(brain), MemberRole.OWNER

    async def list_user_brains(
        self, user_id: UUID, *, limit: int | None = 50, offset: int = 0
    ) -> list[tuple[Brain, MemberRole]]:
        stmt = (
            select(BrainORM, BrainMembership.role)
            .join(BrainMembership, BrainMembership.brain_id == BrainORM.id)
            .where(BrainMembership.user_id == user_id)
            .order_by(BrainORM.created_at.desc())
            .offset(offset)
        )
        if limit is not None:
            stmt = stmt.limit(limit)
        result = await self.session.execute(stmt)
        return [(Brain.model_validate(brain), role) for brain, role in result.all()]

    async def count_user_brains(self, user_id: UUID) -> int:
        return (
            await self.session.scalar(
                select(func.count())
                .select_from(BrainORM)
                .join(BrainMembership, BrainMembership.brain_id == BrainORM.id)
                .where(BrainMembership.user_id == user_id)
            )
        ) or 0

    async def is_member(self, brain_id: UUID, user_id: UUID) -> bool:
        result = await self.session.execute(
            select(BrainMembership.id).where(
                BrainMembership.brain_id == brain_id,
                BrainMembership.user_id == user_id,
            )
        )
        return result.scalar_one_or_none() is not None

    async def get_role(self, brain_id: UUID, user_id: UUID) -> MemberRole | None:
        result = await self.session.execute(
            select(BrainMembership.role).where(
                BrainMembership.brain_id == brain_id,
                BrainMembership.user_id == user_id,
            )
        )
        return result.scalar_one_or_none()

    async def get_member_count(self, brain_id: UUID) -> int:
        result = await self.session.execute(
            select(func.count()).where(BrainMembership.brain_id == brain_id)
        )
        return result.scalar_one()

    async def list_members(
        self, brain_id: UUID, *, limit: int = 50, offset: int = 0
    ) -> list[tuple[BrainMembership, str]]:
        result = await self.session.execute(
            select(BrainMembership, User.email)
            .join(User, User.id == BrainMembership.user_id)
            .where(BrainMembership.brain_id == brain_id)
            .order_by(User.email)
            .offset(offset)
            .limit(limit)
        )
        return result.all()

    async def upsert_membership(
        self, brain_id: UUID, user_id: UUID, role: MemberRole
    ) -> BrainMembership:
        result = await self.session.execute(
            select(BrainMembership).where(
                BrainMembership.brain_id == brain_id,
                BrainMembership.user_id == user_id,
            )
        )
        membership = result.scalar_one_or_none()
        if membership is None:
            membership = BrainMembership(brain_id=brain_id, user_id=user_id, role=role)
            self.session.add(membership)
        else:
            membership.role = role
        return membership

    async def delete_membership(self, brain_id: UUID, user_id: UUID) -> bool:
        result = await self.session.execute(
            select(BrainMembership).where(
                BrainMembership.brain_id == brain_id,
                BrainMembership.user_id == user_id,
            )
        )
        membership = result.scalar_one_or_none()
        if membership is None:
            return False
        await self.session.delete(membership)
        return True
