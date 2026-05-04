"""User service: provisioning and lifecycle."""


import logging
from typing import TYPE_CHECKING
from uuid import UUID

from great_minds.core.mail import normalize_email
from great_minds.core.r2_admin import R2Admin
from great_minds.core.users.schemas import User
from great_minds.core.users.repository import UserRepository

if TYPE_CHECKING:
    # Cycle-breaker: importing VaultService at runtime triggers
    # ``users/__init__.py`` → ``UserService`` → ``VaultService`` →
    # ``VaultRepository`` (mid-import via vaults/__init__.py loading).
    # TYPE_CHECKING gates the import to type-check time only.
    from great_minds.core.vaults.service import VaultService
    from great_minds.core.settings import Settings

log = logging.getLogger(__name__)


class UserService:
    def __init__(
        self,
        repo: UserRepository,
        vault_service: VaultService,
        settings: Settings,
    ) -> None:
        self.repo = repo
        self.vault_service = vault_service
        self.settings = settings

    async def ensure_user(self, email: str) -> User:
        return await self.repo.ensure_user(normalize_email(email))

    async def get_by_id(self, user_id: UUID) -> User | None:
        return await self.repo.get_by_id(user_id)

    async def delete_self(self, user_id: UUID) -> None:
        """Self-service account delete.

        Drops every vault the user owns (storage + DB), then the user row
        (cascading api_keys, refresh_tokens, memberships), then the
        user's R2 bucket if any. Vaults where the user is only a member
        stay in place; the membership cascades away with the user row.
        """
        owned = await self.vault_service.list_owned_by(user_id)
        for vault in owned:
            await self.vault_service.delete_vault(vault.id)

        user = await self.repo.get_by_id(user_id)
        if user is None:
            raise ValueError(f"User {user_id} not found")
        bucket_name = user.r2_bucket_name

        await self.repo.delete(user_id)
        await self.repo.session.commit()

        if bucket_name and self.settings.storage_backend == "r2":
            admin = R2Admin(
                account_id=self.settings.r2_account_id,
                access_key_id=self.settings.r2_access_key_id,
                secret_access_key=self.settings.r2_secret_access_key,
            )
            await admin.delete_bucket(bucket_name)
