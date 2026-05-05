"""Vault service: access control, vault lifecycle, and membership operations."""

import logging
from uuid import UUID

from great_minds.core.vaults.config import (
    apply_vault_config_overrides,
    load_default_config_text,
)
from great_minds.core.vaults.models import MemberRole
from great_minds.core.vaults.repository import VaultRepository
from great_minds.core.vaults.schemas import (
    MemberWithEmail,
    MembershipInternal,
    Vault,
    VaultWithRole,
)
from great_minds.core.pagination import Page, PageInfo, PageParams
from great_minds.core.crypto import decode_access_token
from great_minds.core.paths import CONFIG_PATH
from great_minds.core.r2_admin import R2Admin, derive_user_bucket_name
from great_minds.core.settings import Settings
from great_minds.core.storage import Storage
from great_minds.core.storage_factory import make_storage
from great_minds.core.users.repository import UserRepository

log = logging.getLogger(__name__)


class VaultService:
    """Manages vault access control, lifecycle, and membership operations.

    Holds ``settings`` so storage construction (and per-owner R2 bucket
    provisioning) can stay encapsulated inside lifecycle calls.
    """

    def __init__(
        self,
        repository: VaultRepository,
        user_repo: UserRepository,
        settings: Settings,
    ) -> None:
        self.repo = repository
        self.user_repo = user_repo
        self.settings = settings

    async def _commit(self) -> None:
        await self.repo.session.commit()

    def get_storage(self, vault: Vault) -> Storage:
        return make_storage(vault, self.settings)

    async def get_storage_by_id(self, vault_id: UUID) -> Storage:
        vault = await self.get_vault(vault_id)
        return make_storage(vault, self.settings)

    async def get_vault(self, vault_id: UUID) -> Vault:
        """Fetch a vault by ID. Raises ValueError if not found."""
        vault = await self.repo.get_by_id(vault_id)
        if vault is None:
            raise ValueError(f"Vault {vault_id} not found")
        return vault

    async def ensure_default_for_user(self, access_token: str, email: str) -> None:
        """Create a default vault for a user who has none. Idempotent.

        Decodes the ``sub`` claim from the access token to identify the
        user, so callers don't need to extract the user ID separately.
        """
        user_id = decode_access_token(access_token, self.settings)
        existing = await self.repo.count_user_vaults(user_id)
        if existing:
            return
        await self.create_vault(f"{email}'s vault", user_id)

    async def list_vaults_page(
        self, user_id: UUID, *, pagination: PageParams
    ) -> Page[VaultWithRole]:
        rows = await self.repo.list_user_vaults(
            user_id, limit=pagination.limit, offset=pagination.offset
        )
        total = await self.repo.count_user_vaults(user_id)
        return Page(
            items=rows,
            pagination=PageInfo(
                limit=pagination.limit,
                offset=pagination.offset,
                total=total,
            ),
        )

    async def create_vault(
        self,
        name: str,
        owner_id: UUID,
        *,
        thematic_hint: str | None = None,
        kinds: list[str] | None = None,
        commit: bool = True,
    ) -> Vault:
        bucket_name = await self._ensure_owner_bucket(owner_id)
        vault = await self.repo.create_vault(
            name, owner_id, r2_bucket_name=bucket_name
        )
        await self._init_vault_storage(vault)
        if thematic_hint is not None or kinds is not None:
            await apply_vault_config_overrides(
                self.get_storage(vault),
                thematic_hint=thematic_hint,
                kinds=kinds,
            )
        if commit:
            await self._commit()
        return vault

    async def update_config(
        self,
        vault_id: UUID,
        *,
        thematic_hint: str | None = None,
        kinds: list[str] | None = None,
    ) -> None:
        await apply_vault_config_overrides(
            await self.get_storage_by_id(vault_id),
            thematic_hint=thematic_hint,
            kinds=kinds,
        )

    async def delete_vault(self, vault_id: UUID) -> Vault | None:
        """Drop a vault and its storage. Idempotent on missing vault.

        Order: capture → DB delete → commit → storage clear. The DB
        commit lands first so a storage-clear failure leaves orphaned
        keys (re-runnable) instead of an orphaned vault row pointing at
        cleared storage.
        """
        vault = await self.repo.get_by_id(vault_id)
        if vault is None:
            return None
        await self.repo.delete_vault(vault_id)
        await self._commit()
        storage = self.get_storage(vault)
        await storage.clear()
        return vault

    async def list_owned_by(self, user_id: UUID) -> list[Vault]:
        return await self.repo.list_owned_by(user_id)

    async def _init_vault_storage(self, vault: Vault) -> None:
        storage = self.get_storage(vault)
        if not await storage.exists(CONFIG_PATH):
            await storage.write(CONFIG_PATH, load_default_config_text())

    async def _ensure_owner_bucket(self, owner_id: UUID) -> str | None:
        """For r2 backend: ensure owner has a bucket; return its name. Else None.

        Lazy provisioning: the first vault creation for a user provisions
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

    async def get_member_count(self, vault_id: UUID) -> int:
        return await self.repo.get_member_count(vault_id)

    async def list_members(
        self, vault_id: UUID, *, limit: int = 50, offset: int = 0
    ) -> list[MemberWithEmail]:
        return await self.repo.list_members(vault_id, limit=limit, offset=offset)

    async def list_members_page(
        self, vault_id: UUID, *, pagination: PageParams
    ) -> Page[MemberWithEmail]:
        rows = await self.repo.list_members(
            vault_id, limit=pagination.limit, offset=pagination.offset
        )
        total = await self.repo.get_member_count(vault_id)
        return Page(
            items=rows,
            pagination=PageInfo(
                limit=pagination.limit,
                offset=pagination.offset,
                total=total,
            ),
        )

    async def add_member(self, change: MembershipInternal) -> None:
        """Add a member. Idempotent — no-op if already a member.

        Does NOT change the role of an existing member. Use
        ``set_member_role`` for role changes.
        """
        await self.repo.add_member(change.vault_id, change.user_id, change.role)
        await self._commit()

    async def set_member_role(self, change: MembershipInternal) -> None:
        """Change an existing member's role.

        Raises ValueError if the user is not a member of the vault.
        """
        await self.repo.set_member_role(change.vault_id, change.user_id, change.role)
        await self._commit()

    async def delete_membership(self, vault_id: UUID, user_id: UUID) -> bool:
        deleted = await self.repo.delete_membership(vault_id, user_id)
        await self._commit()
        return deleted
