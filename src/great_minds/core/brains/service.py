"""Brain service: access control, brain lifecycle, and membership operations."""

import logging
from uuid import UUID

from great_minds.core.brains.config import (
    apply_brain_config_overrides,
    load_default_config_text,
)
from great_minds.core.brains.models import BrainMembership, MemberRole
from great_minds.core.brains.repository import BrainRepository
from great_minds.core.brains.schemas import (
    Brain,
    BrainWithRole,
    MemberWithEmail,
)
from great_minds.core.pagination import Page, PageInfo, PageParams
from great_minds.core.paths import CONFIG_PATH
from great_minds.core.r2_admin import R2Admin, derive_user_bucket_name
from great_minds.core.settings import Settings
from great_minds.core.storage import Storage
from great_minds.core.storage_factory import make_storage
from great_minds.core.users.repository import UserRepository

log = logging.getLogger(__name__)


class BrainService:
    """Manages brain access control, lifecycle, and membership operations.

    Holds ``settings`` so storage construction (and per-owner R2 bucket
    provisioning) can stay encapsulated inside lifecycle calls.
    """

    def __init__(
        self,
        repository: BrainRepository,
        user_repo: UserRepository,
        settings: Settings,
    ) -> None:
        self.repo = repository
        self.user_repo = user_repo
        self.settings = settings

    async def _commit(self) -> None:
        await self.repo.session.commit()

    def get_storage(self, brain: Brain) -> Storage:
        return make_storage(brain, self.settings)

    async def get_storage_by_id(self, brain_id: UUID) -> Storage:
        brain = await self.get_brain(brain_id)
        return make_storage(brain, self.settings)

    async def get_brain(self, brain_id: UUID) -> Brain:
        """Fetch a brain by ID. Raises ValueError if not found."""
        brain = await self.repo.get_by_id(brain_id)
        if brain is None:
            raise ValueError(f"Brain {brain_id} not found")
        return brain

    async def list_brains(
        self, user_id: UUID, *, limit: int = 50, offset: int = 0
    ) -> list[BrainWithRole]:
        return await self.repo.list_user_brains(user_id, limit=limit, offset=offset)

    async def ensure_default_for_user(self, user_id: UUID, email: str) -> None:
        """Create a default brain for a user who has none. Idempotent."""
        existing = await self.repo.list_user_brains(user_id, limit=1, offset=0)
        if existing:
            return
        await self.create_brain(f"{email}'s brain", user_id)

    async def list_brains_page(
        self, user_id: UUID, *, pagination: PageParams
    ) -> Page[BrainWithRole]:
        rows = await self.repo.list_user_brains(
            user_id, limit=pagination.limit, offset=pagination.offset
        )
        total = await self.repo.count_user_brains(user_id)
        return Page(
            items=rows,
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
    ) -> Brain:
        bucket_name = await self._ensure_owner_bucket(owner_id)
        brain = await self.repo.create_brain(
            name, owner_id, r2_bucket_name=bucket_name
        )
        await self._init_brain_storage(brain)
        if thematic_hint is not None or kinds is not None:
            await apply_brain_config_overrides(
                self.get_storage(brain),
                thematic_hint=thematic_hint,
                kinds=kinds,
            )
        if commit:
            await self._commit()
        return brain

    async def update_config(
        self,
        brain_id: UUID,
        *,
        thematic_hint: str | None = None,
        kinds: list[str] | None = None,
    ) -> None:
        await apply_brain_config_overrides(
            await self.get_storage_by_id(brain_id),
            thematic_hint=thematic_hint,
            kinds=kinds,
        )

    async def delete_brain(self, brain_id: UUID) -> Brain | None:
        """Drop a brain and its storage. Idempotent on missing brain.

        Order: capture → DB delete → commit → storage clear. The DB
        commit lands first so a storage-clear failure leaves orphaned
        keys (re-runnable) instead of an orphaned brain row pointing at
        cleared storage.
        """
        brain = await self.repo.get_by_id(brain_id)
        if brain is None:
            return None
        await self.repo.delete_brain(brain_id)
        await self._commit()
        storage = self.get_storage(brain)
        await storage.clear()
        return brain

    async def list_owned_by(self, user_id: UUID) -> list[Brain]:
        return await self.repo.list_owned_by(user_id)

    async def _init_brain_storage(self, brain: Brain) -> None:
        storage = self.get_storage(brain)
        if not await storage.exists(CONFIG_PATH):
            await storage.write(CONFIG_PATH, load_default_config_text())

    async def _ensure_owner_bucket(self, owner_id: UUID) -> str | None:
        """For r2 backend: ensure owner has a bucket; return its name. Else None.

        Lazy provisioning: the first brain creation for a user provisions
        their R2 bucket. The bucket name is deterministic (derived from
        user_id + ``r2_bucket_prefix``), so re-invocation after partial
        failure converges instead of creating duplicates.
        """
        if self.settings.storage_backend != "r2":
            return None
        user = await self.user_repo.get_by_id(owner_id)
        if user is None:
            raise ValueError(f"User {owner_id} not found")
        if user.r2_bucket_name:
            return user.r2_bucket_name
        bucket_name = derive_user_bucket_name(
            self.settings.r2_bucket_prefix, owner_id
        )
        admin = R2Admin(
            account_id=self.settings.r2_account_id,
            access_key_id=self.settings.r2_access_key_id,
            secret_access_key=self.settings.r2_secret_access_key,
        )
        await admin.ensure_bucket(
            bucket_name, cors_origins=self.settings.cors_origins
        )
        await self.user_repo.set_r2_bucket_name(owner_id, bucket_name)
        return bucket_name

    async def get_member_count(self, brain_id: UUID) -> int:
        return await self.repo.get_member_count(brain_id)

    async def list_members(
        self, brain_id: UUID, *, limit: int = 50, offset: int = 0
    ) -> list[MemberWithEmail]:
        return await self.repo.list_members(brain_id, limit=limit, offset=offset)

    async def list_members_page(
        self, brain_id: UUID, *, pagination: PageParams
    ) -> Page[MemberWithEmail]:
        rows = await self.repo.list_members(
            brain_id, limit=pagination.limit, offset=pagination.offset
        )
        total = await self.repo.get_member_count(brain_id)
        return Page(
            items=rows,
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
