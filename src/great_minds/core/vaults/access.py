from uuid import UUID

from great_minds.core.authz import Forbidden
from great_minds.core.vaults.models import MemberRole
from great_minds.core.vaults.repository import VaultRepository


class VaultAccess:
    def __init__(self, repo: VaultRepository) -> None:
        self.repo = repo

    async def require_member(self, vault_id: UUID, user_id: UUID) -> None:
        role = await self.get_member_role(vault_id, user_id)
        if role is None:
            raise Forbidden

    async def require_owner(self, vault_id: UUID, user_id: UUID) -> None:
        role = await self.get_member_role(vault_id, user_id)
        if role != MemberRole.OWNER:
            raise Forbidden

    async def get_member_role(self, vault_id: UUID, user_id: UUID) -> MemberRole | None:
        return await self.repo.get_role(vault_id, user_id)
