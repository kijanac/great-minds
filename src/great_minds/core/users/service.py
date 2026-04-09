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

    async def ensure_default_brain(self, user: User) -> None:
        """Ensure the user has at least one brain with storage initialized."""
        brains = await self.brain_service.list_brains(user.id)
        if not brains:
            await self.brain_service.create_brain(
                f"{user.email}'s brain",
                user.id,
            )
        else:
            self.brain_service._init_brain_storage(brains[0][0])
