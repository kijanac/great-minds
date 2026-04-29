import uuid
from datetime import datetime

from pydantic import BaseModel

from great_minds.core.brains.models import MemberRole


class BrainOverview(BaseModel):
    id: uuid.UUID
    name: str
    role: MemberRole


class Brain(BrainOverview):
    owner_id: uuid.UUID
    created_at: datetime


class BrainDetail(Brain):
    member_count: int
    article_count: int


class BrainCreate(BaseModel):
    name: str
    thematic_hint: str | None = None
    kinds: list[str] | None = None


class BrainUpdate(BaseModel):
    name: str | None = None


class BrainConfigUpdate(BaseModel):
    thematic_hint: str | None = None
    kinds: list[str] | None = None


class BrainConfig(BaseModel):
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
