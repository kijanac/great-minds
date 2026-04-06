"""Brain repository: database operations."""

from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.core.brains.models import BrainORM, BrainMembership, BrainKind, MemberRole
from great_minds.core.brains.schemas import Brain
from great_minds.core.users.models import User


class BrainRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def create_personal_brain(self, user: User) -> Brain:
        slug = f"personal-{user.id.hex[:8]}"
        brain = BrainORM(
            name=f"{user.email}'s brain",
            slug=slug,
            owner_id=user.id,
            kind=BrainKind.PERSONAL,
            storage_root=f"brains/{slug}",
        )
        self.session.add(brain)
        await self.session.flush()
        self.session.add(BrainMembership(brain_id=brain.id, user_id=user.id, role=MemberRole.OWNER))
        await self.session.refresh(brain)
        return Brain.model_validate(brain)

    async def create_team_brain(self, name: str, owner_id: UUID) -> tuple[Brain, MemberRole]:
        slug = name.lower().replace(" ", "-")
        brain = BrainORM(
            name=name,
            slug=slug,
            owner_id=owner_id,
            kind=BrainKind.TEAM,
            storage_root=f"brains/{slug}",
        )
        self.session.add(brain)
        await self.session.flush()
        await self.upsert_membership(brain.id, owner_id, MemberRole.OWNER)
        await self.session.refresh(brain)
        return Brain.model_validate(brain), MemberRole.OWNER

    async def list_user_brains(self, user_id: UUID) -> list[tuple[Brain, MemberRole]]:
        result = await self.session.execute(
            select(BrainORM, BrainMembership.role)
            .join(BrainMembership, BrainMembership.brain_id == BrainORM.id)
            .where(BrainMembership.user_id == user_id)
        )
        return [(Brain.model_validate(brain), role) for brain, role in result.all()]

    async def get_brain_with_role(self, brain_id: UUID, user_id: UUID) -> tuple[Brain, MemberRole] | None:
        result = await self.session.execute(
            select(BrainORM, BrainMembership.role)
            .join(BrainMembership, BrainMembership.brain_id == BrainORM.id)
            .where(BrainORM.id == brain_id, BrainMembership.user_id == user_id)
        )
        row = result.one_or_none()
        if row is None:
            return None
        return Brain.model_validate(row[0]), row[1]

    async def get_personal_brain(self, user_id: UUID) -> Brain | None:
        result = await self.session.execute(
            select(BrainORM)
            .join(BrainMembership, BrainMembership.brain_id == BrainORM.id)
            .where(BrainMembership.user_id == user_id, BrainORM.kind == BrainKind.PERSONAL)
        )
        brain = result.scalar_one_or_none()
        if brain is None:
            return None
        return Brain.model_validate(brain)

    async def get_member_count(self, brain_id: UUID) -> int:
        result = await self.session.execute(
            select(func.count()).where(BrainMembership.brain_id == brain_id)
        )
        return result.scalar_one()

    async def list_members(self, brain_id: UUID) -> list[tuple[BrainMembership, str]]:
        result = await self.session.execute(
            select(BrainMembership, User.email)
            .join(User, User.id == BrainMembership.user_id)
            .where(BrainMembership.brain_id == brain_id)
        )
        return result.all()

    async def upsert_membership(self, brain_id: UUID, user_id: UUID, role: MemberRole) -> BrainMembership:
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

    async def list_team_member_personal_brains(self, brain_id: UUID) -> list[Brain]:
        """Find personal brains of all members of the given brain."""
        result = await self.session.execute(
            select(BrainORM)
            .join(BrainMembership, BrainMembership.user_id.in_(
                select(BrainMembership.user_id).where(
                    BrainMembership.brain_id == brain_id,
                )
            ))
            .where(BrainORM.kind == BrainKind.PERSONAL)
            .distinct()
        )
        return [Brain.model_validate(b) for b in result.scalars().all()]
