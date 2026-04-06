import uuid
from datetime import datetime

from pydantic import BaseModel


class BrainOverview(BaseModel):
    id: uuid.UUID
    name: str
    kind: str
    role: str


class Brain(BrainOverview):
    slug: str
    owner_id: uuid.UUID
    created_at: datetime


class BrainDetail(Brain):
    member_count: int
    article_count: int


class BrainCreate(BaseModel):
    name: str


class BrainUpdate(BaseModel):
    name: str | None = None


class MembershipOverview(BaseModel):
    user_id: uuid.UUID
    email: str
    role: str


class MembershipUpdate(BaseModel):
    role: str
