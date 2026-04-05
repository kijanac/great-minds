"""Brain repository: database operations."""

from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.api.auth.models import User
from great_minds.api.brains.models import Brain, BrainMembership, BrainType, MemberRole


async def create_personal_brain(session: AsyncSession, user: User) -> Brain:
    slug = f"personal-{user.id.hex[:8]}"
    brain = Brain(
        name=f"{user.email}'s brain",
        slug=slug,
        owner_id=user.id,
        type=BrainType.PERSONAL,
        storage_root=f"brains/{slug}",
    )
    session.add(brain)
    await session.flush()
    session.add(BrainMembership(brain_id=brain.id, user_id=user.id, role=MemberRole.OWNER))
    return brain


async def list_user_brains(session: AsyncSession, user_id: UUID) -> list[tuple[Brain, MemberRole]]:
    result = await session.execute(
        select(Brain, BrainMembership.role)
        .join(BrainMembership, BrainMembership.brain_id == Brain.id)
        .where(BrainMembership.user_id == user_id)
    )
    return result.all()


async def get_brain_with_role(session: AsyncSession, brain_id: UUID, user_id: UUID) -> tuple[Brain, MemberRole] | None:
    result = await session.execute(
        select(Brain, BrainMembership.role)
        .join(BrainMembership, BrainMembership.brain_id == Brain.id)
        .where(Brain.id == brain_id, BrainMembership.user_id == user_id)
    )
    return result.one_or_none()


async def get_personal_brain(session: AsyncSession, user_id: UUID) -> Brain | None:
    result = await session.execute(
        select(Brain)
        .join(BrainMembership, BrainMembership.brain_id == Brain.id)
        .where(BrainMembership.user_id == user_id, Brain.type == BrainType.PERSONAL)
    )
    return result.scalar_one_or_none()


async def get_member_count(session: AsyncSession, brain_id: UUID) -> int:
    result = await session.execute(
        select(func.count()).where(BrainMembership.brain_id == brain_id)
    )
    return result.scalar_one()


async def list_members(session: AsyncSession, brain_id: UUID) -> list[tuple[BrainMembership, str]]:
    result = await session.execute(
        select(BrainMembership, User.email)
        .join(User, User.id == BrainMembership.user_id)
        .where(BrainMembership.brain_id == brain_id)
    )
    return result.all()


async def upsert_membership(session: AsyncSession, brain_id: UUID, user_id: UUID, role: MemberRole) -> BrainMembership:
    result = await session.execute(
        select(BrainMembership).where(
            BrainMembership.brain_id == brain_id,
            BrainMembership.user_id == user_id,
        )
    )
    membership = result.scalar_one_or_none()
    if membership is None:
        membership = BrainMembership(brain_id=brain_id, user_id=user_id, role=role)
        session.add(membership)
    else:
        membership.role = role
    return membership


async def delete_membership(session: AsyncSession, brain_id: UUID, user_id: UUID) -> bool:
    result = await session.execute(
        select(BrainMembership).where(
            BrainMembership.brain_id == brain_id,
            BrainMembership.user_id == user_id,
        )
    )
    membership = result.scalar_one_or_none()
    if membership is None:
        return False
    await session.delete(membership)
    return True
