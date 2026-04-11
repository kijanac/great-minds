"""User service: provisioning and lifecycle."""

from uuid import UUID

from great_minds.core.brains.service import BrainService
from great_minds.core.mail import normalize_email
from great_minds.core.users.models import User
from great_minds.core.users.repository import UserRepository


class UserService:
    def __init__(self, repo: UserRepository, brain_service: BrainService) -> None:
        self.repo = repo
        self.brain_service = brain_service

    async def get_or_create(self, email: str) -> tuple[User, bool]:
        return await self.repo.get_or_create(normalize_email(email))

    async def get_by_id(self, user_id: UUID) -> User | None:
        return await self.repo.get_by_id(user_id)

    async def ensure_default_brain(self, user: User) -> None:
        """Ensure the user has at least one brain with storage initialized."""
        brains = await self.brain_service.list_brains(user.id)
        if not brains:
            await self.brain_service.create_brain(
                f"{user.email}'s brain",
                user.id,
                commit=False,
            )
        else:
            self.brain_service._init_brain_storage(brains[0][0])
