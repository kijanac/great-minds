"""Auth domain schemas."""

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict

class ApiKey(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    label: str
    created_at: datetime
    revoked: bool
