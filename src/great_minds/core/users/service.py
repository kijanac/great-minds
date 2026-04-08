"""User service: provisioning and lifecycle."""

from great_minds.core.brains.service import BrainService
from great_minds.core.users.models import User
from great_minds.core.users.repository import UserRepository


class UserService:
    def __init__(self, repo: UserRepository, brain_service: BrainService) -> None:
        self.repo = repo
        self.brain_service = brain_service

    async def get_or_create(self, email: str) -> tuple[User, bool]:
        return await self.repo.get_or_create(email)

    async def ensure_personal_brain(self, user: User) -> None:
        """Ensure the user has a personal brain with storage initialized."""
        existing = await self.brain_service.repo.get_personal_brain(user.id)
        if existing is None:
            await self.brain_service.create_personal_brain(user)
        else:
            self.brain_service._init_brain_storage(existing.storage_root)
