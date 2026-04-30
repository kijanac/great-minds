"""Brain service: access control, brain lifecycle, and membership operations."""

import logging
from uuid import UUID

from great_minds.core.brain import load_default_config_text
from great_minds.core.brain_config import apply_brain_config_overrides
from great_minds.core.brains.models import BrainMembership, MemberRole
from great_minds.core.brains.repository import BrainRepository
from great_minds.core.brains.schemas import (
    Brain,
    BrainWithRole,
    MemberWithEmail,
)
from great_minds.core.pagination import Page, PageInfo, PageParams
from great_minds.core.paths import CONFIG_PATH
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

    async def get_brain(self, brain_id: UUID) -> Brain:
        """Fetch a brain by ID. Raises ValueError if not found."""
        brain = await self.repo.get_by_id(brain_id)
        if brain is None:
            raise ValueError(f"Brain {brain_id} not found")
        return brain

    async def list_brains(
        self, user_id: UUID, *, limit: int = 50, offset: int = 0
    ) -> list[tuple[Brain, MemberRole]]:
        return await self.repo.list_user_brains(user_id, limit=limit, offset=offset)

    async def list_brains_page(
        self, user_id: UUID, *, pagination: PageParams
    ) -> Page[BrainWithRole]:
        rows = await self.repo.list_user_brains(
            user_id, limit=pagination.limit, offset=pagination.offset
        )
        total = await self.repo.count_user_brains(user_id)
        return Page(
            items=[
                BrainWithRole(brain=brain, role=role)
                for brain, role in rows
            ],
            pagination=PageInfo(
                limit=pagination.limit,
                offset=pagination.offset,
                total=total,
            ),
        )

    async def create_brain(
        self,
        name: str,
        owner_id: UUID,
        *,
        thematic_hint: str | None = None,
        kinds: list[str] | None = None,
        commit: bool = True,
    ) -> tuple[Brain, MemberRole]:
        brain, role = await self.repo.create_brain(name, owner_id)
        await self._init_brain_storage(brain)
        if thematic_hint is not None or kinds is not None:
            await apply_brain_config_overrides(
                self.get_storage(brain),
                thematic_hint=thematic_hint,
                kinds=kinds,
            )
        if commit:
            await self._commit()
        return brain, role

    async def update_config(
        self,
        brain_id: UUID,
        *,
        thematic_hint: str | None = None,
        kinds: list[str] | None = None,
    ) -> None:
        await apply_brain_config_overrides(
            self.get_storage_by_id(brain_id),
            thematic_hint=thematic_hint,
            kinds=kinds,
        )

    async def _init_brain_storage(self, brain: Brain) -> None:
        storage = self.get_storage(brain)
        if not await storage.exists(CONFIG_PATH):
            await storage.write(CONFIG_PATH, load_default_config_text())

    async def get_member_count(self, brain_id: UUID) -> int:
        return await self.repo.get_member_count(brain_id)

    async def list_members(
        self, brain_id: UUID, *, limit: int = 50, offset: int = 0
    ) -> list[tuple[BrainMembership, str]]:
        return await self.repo.list_members(brain_id, limit=limit, offset=offset)

    async def list_members_page(
        self, brain_id: UUID, *, pagination: PageParams
    ) -> Page[MemberWithEmail]:
        rows = await self.repo.list_members(
            brain_id, limit=pagination.limit, offset=pagination.offset
        )
        total = await self.repo.get_member_count(brain_id)
        return Page(
            items=[
                MemberWithEmail(
                    user_id=membership.user_id,
                    role=membership.role,
                    email=email,
                )
                for membership, email in rows
            ],
            pagination=PageInfo(
                limit=pagination.limit,
                offset=pagination.offset,
                total=total,
            ),
        )

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
