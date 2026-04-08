"""Brain service: access control, brain lifecycle, and membership operations."""

import logging
from pathlib import Path
from uuid import UUID

from great_minds.core.brains.models import BrainMembership, MemberRole
from great_minds.core.brains.repository import BrainRepository
from great_minds.core.brains.schemas import Brain
from great_minds.core.querier import QuerySource
from great_minds.core.settings import Settings
from great_minds.core.storage import LocalStorage
from great_minds.core.users.models import User

log = logging.getLogger(__name__)


class BrainService:
    """Manages brain access control, lifecycle, and membership operations."""

    def __init__(self, repository: BrainRepository, settings: Settings) -> None:
        self.repo = repository
        self.data_dir = Path(settings.data_dir)

    async def get_brain(
        self, brain_id: UUID, user_id: UUID
    ) -> tuple[Brain, MemberRole]:
        """Fetch a brain by ID with access check. Raises ValueError if not found."""
        result = await self.repo.get_brain_with_role(brain_id, user_id)
        if result is None:
            raise ValueError(f"Brain {brain_id} not found or not accessible")
        return result

    async def list_brains(self, user_id: UUID) -> list[tuple[Brain, MemberRole]]:
        return await self.repo.list_user_brains(user_id)

    async def create_team_brain(
        self, name: str, owner_id: UUID
    ) -> tuple[Brain, MemberRole]:
        return await self.repo.create_team_brain(name, owner_id)

    async def create_personal_brain(self, user: User) -> Brain:
        brain = await self.repo.create_personal_brain(user)
        self._init_brain_storage(brain.storage_root)
        return brain

    def _init_brain_storage(self, storage_root: str) -> None:
        storage = LocalStorage(self.data_dir / storage_root)
        if not storage.exists("config.yaml"):
            default = Path(__file__).resolve().parent.parent / "default_config.yaml"
            storage.write("config.yaml", default.read_text(encoding="utf-8"))

    async def get_all_query_sources(self, user_id: UUID) -> list[QuerySource]:
        """Build QuerySources for all brains a user has access to."""
        rows = await self.repo.list_user_brains(user_id)
        return [
            QuerySource(
                storage=LocalStorage(self.data_dir / brain.storage_root),
                label=brain.slug,
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
        return await self.repo.upsert_membership(brain_id, user_id, role)

    async def delete_membership(self, brain_id: UUID, user_id: UUID) -> bool:
        return await self.repo.delete_membership(brain_id, user_id)
