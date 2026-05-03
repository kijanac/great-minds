"""User repository: database operations for users."""

from uuid import UUID

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.core.users.models import User


class UserRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get_or_create(self, email: str) -> tuple[User, bool]:
        """Returns (user, created) — created is True if this is a new user."""
        result = await self.session.execute(select(User).where(User.email == email))
        user = result.scalar_one_or_none()
        if user is None:
            user = User(email=email)
            self.session.add(user)
            await self.session.flush()
            return user, True
        return user, False

    async def get_by_id(self, user_id: UUID) -> User | None:
        result = await self.session.execute(select(User).where(User.id == user_id))
        return result.scalar_one_or_none()

    async def set_r2_bucket_name(self, user_id: UUID, bucket_name: str) -> None:
        user = await self.get_by_id(user_id)
        if user is None:
            raise ValueError(f"User {user_id} not found")
        user.r2_bucket_name = bucket_name
        await self.session.flush()

    async def delete(self, user_id: UUID) -> None:
        """Drop the user row. Cascades to api_keys, refresh_tokens, memberships.

        Caller commits.
        """
        await self.session.execute(delete(User).where(User.id == user_id))
