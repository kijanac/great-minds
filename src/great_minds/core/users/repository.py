"""User repository: database operations for users."""

from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.core.users.models import User


async def get_or_create_user(session: AsyncSession, email: str) -> tuple[User, bool]:
    """Returns (user, created) — created is True if this is a new user."""
    result = await session.execute(select(User).where(User.email == email))
    user = result.scalar_one_or_none()
    if user is None:
        user = User(email=email)
        session.add(user)
        await session.flush()
        return user, True
    return user, False


async def get_user_by_id(session: AsyncSession, user_id: UUID) -> User | None:
    result = await session.execute(select(User).where(User.id == user_id))
    return result.scalar_one_or_none()
