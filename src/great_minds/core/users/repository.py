"""User repository: database operations for users."""

from uuid import UUID

from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.core.users.models import UserORM
from great_minds.core.users.schemas import User as UserSchema


class UserRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def ensure_user(self, email: str) -> UserSchema:
        """Return the user row for email, creating it if missing.

        Idempotent and concurrency-safe via ``ON CONFLICT DO NOTHING``
        on the unique ``email`` index.
        """
        stmt = (
            insert(UserORM)
            .values(email=email)
            .on_conflict_do_nothing(index_elements=["email"])
            .returning(UserORM)
        )
        result = await self.session.execute(stmt)
        created = result.scalar_one_or_none()
        if created is not None:
            return UserSchema.model_validate(created)
        # ON CONFLICT suppressed the insert — row already existed.
        existing = await self.session.execute(
            select(UserORM).where(UserORM.email == email)
        )
        return UserSchema.model_validate(existing.scalar_one())

    async def get_by_id(self, user_id: UUID) -> UserSchema | None:
        result = await self.session.execute(select(UserORM).where(UserORM.id == user_id))
        row = result.scalar_one_or_none()
        return UserSchema.model_validate(row) if row else None

    async def set_r2_bucket_name(self, user_id: UUID, bucket_name: str) -> None:
        user = await self.session.execute(
            select(UserORM).where(UserORM.id == user_id)
        )
        orm_user = user.scalar_one_or_none()
        if orm_user is None:
            raise ValueError(f"User {user_id} not found")
        orm_user.r2_bucket_name = bucket_name
        await self.session.flush()

    async def delete(self, user_id: UUID) -> None:
        """Drop the user row. Cascades to api_keys, refresh_tokens, memberships.

        Caller commits.
        """
        await self.session.execute(delete(UserORM).where(UserORM.id == user_id))
