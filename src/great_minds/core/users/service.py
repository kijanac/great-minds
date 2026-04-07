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

    async def provision_new_user(self, user: User) -> None:
        """Set up resources for a newly created user (e.g. personal brain)."""
        await self.brain_service.create_personal_brain(user)
