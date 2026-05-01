"""User service: provisioning and lifecycle."""

from uuid import UUID

from great_minds.core.mail import normalize_email
from great_minds.core.users.models import User
from great_minds.core.users.repository import UserRepository


class UserService:
    def __init__(self, repo: UserRepository) -> None:
        self.repo = repo

    async def get_or_create(self, email: str) -> tuple[User, bool]:
        return await self.repo.get_or_create(normalize_email(email))

    async def get_by_id(self, user_id: UUID) -> User | None:
        return await self.repo.get_by_id(user_id)
