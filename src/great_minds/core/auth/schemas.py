"""Auth domain schemas."""

import uuid
from datetime import datetime

from pydantic import BaseModel


class ApiKeyOverview(BaseModel):
    id: uuid.UUID
    label: str
    created_at: datetime


class ApiKey(ApiKeyOverview):
    revoked: bool
