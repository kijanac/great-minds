"""User domain schemas."""

import uuid
from datetime import datetime

from pydantic import BaseModel


class UserOverview(BaseModel):
    id: uuid.UUID
    email: str


class User(UserOverview):
    created_at: datetime
    r2_bucket_name: str | None = None
