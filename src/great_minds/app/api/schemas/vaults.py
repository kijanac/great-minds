import uuid
from datetime import datetime

from pydantic import BaseModel

from great_minds.core.vaults.models import MemberRole


class VaultOverview(BaseModel):
    id: uuid.UUID
    name: str
    role: MemberRole


class Vault(VaultOverview):
    owner_id: uuid.UUID
    created_at: datetime


class VaultDetail(Vault):
    member_count: int
    article_count: int


class VaultCreate(BaseModel):
    name: str
    thematic_hint: str | None = None
    kinds: list[str] | None = None


class VaultUpdate(BaseModel):
    name: str | None = None


class VaultConfigUpdate(BaseModel):
    thematic_hint: str | None = None
    kinds: list[str] | None = None


class VaultConfig(BaseModel):
    thematic_hint: str
    kinds: list[str]


class DraftHintRequest(BaseModel):
    description: str


class DraftHintResponse(BaseModel):
    thematic_hint: str


class Membership(BaseModel):
    user_id: uuid.UUID
    email: str
    role: MemberRole


class MembershipInvite(BaseModel):
    email: str
    role: MemberRole = MemberRole.EDITOR


class MembershipUpdate(BaseModel):
    role: MemberRole
