"""Auth domain schemas."""

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict


class ApiKeyOverview(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    label: str
    created_at: datetime


class ApiKey(ApiKeyOverview):
    revoked: bool
