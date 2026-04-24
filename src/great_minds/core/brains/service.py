"""Brain service: access control, brain lifecycle, and membership operations."""

import logging
from uuid import UUID

from great_minds.core.brain import load_default_config_text
from great_minds.core.brains.models import BrainMembership, MemberRole
from great_minds.core.brains.repository import BrainRepository
from great_minds.core.brains.schemas import Brain
from great_minds.core.paths import CONFIG_PATH
from great_minds.core.querier import QuerySource
from great_minds.core.storage import Storage
from great_minds.core.storage_factory import make_storage

log = logging.getLogger(__name__)


class BrainService:
    """Manages brain access control, lifecycle, and membership operations."""

    def __init__(self, repository: BrainRepository) -> None:
        self.repo = repository

    async def _commit(self) -> None:
        await self.repo.session.commit()

    def get_storage(self, brain: Brain) -> Storage:
        return self.get_storage_by_id(brain.id)

    def get_storage_by_id(self, brain_id: UUID) -> Storage:
        return make_storage(brain_id)

    async def get_by_id(self, brain_id: UUID) -> Brain:
        """Fetch a brain by ID. Raises ValueError if not found."""
        brain = await self.repo.get_by_id(brain_id)
        if brain is None:
            raise ValueError(f"Brain {brain_id} not found")
        return brain

    async def get_brain(
        self, brain_id: UUID, user_id: UUID
    ) -> tuple[Brain, MemberRole]:
        """Fetch a brain by ID with access check. Raises ValueError if not found."""
        result = await self.repo.get_brain_with_role(brain_id, user_id)
        if result is None:
            raise ValueError(f"Brain {brain_id} not found or not accessible")
        return result

    async def is_member(self, brain_id: UUID, user_id: UUID) -> bool:
        return await self.repo.is_member(brain_id, user_id)

    async def require_owner(
        self, brain_id: UUID, user_id: UUID
    ) -> tuple[Brain, MemberRole]:
        """Fetch a brain and verify the user is an owner. Raises PermissionError if not."""
        result = await self.repo.get_brain_with_role(brain_id, user_id)
        if result is None:
            raise PermissionError(f"Brain {brain_id} not found or not accessible")
        brain, role = result
        if role != MemberRole.OWNER:
            raise PermissionError("Only brain owners can perform this action")
        return brain, role

    async def list_brains(self, user_id: UUID) -> list[tuple[Brain, MemberRole]]:
        return await self.repo.list_user_brains(user_id)

    async def create_brain(
        self, name: str, owner_id: UUID, *, commit: bool = True
    ) -> tuple[Brain, MemberRole]:
        brain, role = await self.repo.create_brain(name, owner_id)
        await self._init_brain_storage(brain)
        if commit:
            await self._commit()
        return brain, role

    async def _init_brain_storage(self, brain: Brain) -> None:
        storage = self.get_storage(brain)
        if not await storage.exists(CONFIG_PATH):
            await storage.write(CONFIG_PATH, load_default_config_text())

    async def get_all_query_sources(self, user_id: UUID) -> list[QuerySource]:
        """Build QuerySources for all brains a user has access to."""
        rows = await self.repo.list_user_brains(user_id)
        return [
            QuerySource(
                storage=self.get_storage(brain),
                label=brain.name,
                brain_id=brain.id,
            )
            for brain, _role in rows
        ]

    async def get_member_count(self, brain_id: UUID) -> int:
        return await self.repo.get_member_count(brain_id)

    async def list_members(self, brain_id: UUID) -> list[tuple[BrainMembership, str]]:
        return await self.repo.list_members(brain_id)

    async def upsert_membership(
        self, brain_id: UUID, user_id: UUID, role: MemberRole
    ) -> BrainMembership:
        membership = await self.repo.upsert_membership(brain_id, user_id, role)
        await self._commit()
        return membership

    async def delete_membership(self, brain_id: UUID, user_id: UUID) -> bool:
        deleted = await self.repo.delete_membership(brain_id, user_id)
        await self._commit()
        return deleted
