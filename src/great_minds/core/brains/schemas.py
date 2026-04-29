"""Brain domain schemas."""

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict

from great_minds.core.brains.models import MemberRole

class Brain(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    owner_id: uuid.UUID
    created_at: datetime


class BrainWithRole(BaseModel):
    brain: Brain
    role: MemberRole


class MemberWithEmail(BaseModel):
    user_id: uuid.UUID
    role: MemberRole
    email: str
