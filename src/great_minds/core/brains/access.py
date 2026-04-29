from uuid import UUID

from great_minds.core.authz import Forbidden
from great_minds.core.brains.models import MemberRole
from great_minds.core.brains.repository import BrainRepository

class BrainAccess:
    def __init__(self, repo: BrainRepository) -> None:
        self.repo = repo
    
    async def require_member(self, brain_id: UUID, user_id: UUID) -> None:
        role = await self.get_member_role(brain_id, user_id)
        if role is None:
            raise Forbidden
    
    async def require_owner(self, brain_id: UUID, user_id: UUID) -> None:
        role = await self.get_member_role(brain_id, user_id)
        if role != MemberRole.OWNER:
            raise Forbidden

    async def get_member_role(self, brain_id: UUID, user_id: UUID) -> MemberRole | None:
        return await self.repo.get_role(brain_id, user_id)
