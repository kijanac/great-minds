"""User service: provisioning and lifecycle."""

from great_minds.core.brains.service import BrainService
from great_minds.core.users.models import User


class UserService:
    def __init__(self, brain_service: BrainService) -> None:
        self.brain_service = brain_service

    async def provision_new_user(self, user: User) -> None:
        """Set up resources for a newly created user (e.g. personal brain)."""
        await self.brain_service.create_personal_brain(user)
