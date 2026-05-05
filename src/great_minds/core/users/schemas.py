"""User domain schemas."""

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict


class UserOverview(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    email: str


class User(UserOverview):
    created_at: datetime
    r2_bucket_name: str | None = None
