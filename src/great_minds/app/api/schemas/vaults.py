"""Vault API schemas — endpoint-specific shapes that compose from core."""

from pydantic import BaseModel

from great_minds.core.pagination import Page
from great_minds.core.vaults.models import MemberRole
from great_minds.core.vaults.schemas import Vault


class VaultDetail(Vault):
    """Single-vault view with role + aggregated counts (cross-domain join)."""

    role: MemberRole
    member_count: int
    article_count: int


class VaultPage(Page[Vault]):
    """Paginated vault list with per-vault roles for the requesting user."""

    roles: dict[str, str]


class VaultConfig(BaseModel):
    """Read shape for the vault config.yaml (storage, not DB)."""

    thematic_hint: str
    kinds: list[str]


class DraftHintRequest(BaseModel):
    description: str


class DraftHintResponse(BaseModel):
    thematic_hint: str


class MembershipInvite(BaseModel):
    email: str
    role: MemberRole = MemberRole.EDITOR


class MembershipUpdate(BaseModel):
    role: MemberRole
