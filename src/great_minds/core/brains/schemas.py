"""Brain domain schemas."""

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict


class Brain(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    slug: str
    owner_id: uuid.UUID
    kind: str
    storage_root: str
    created_at: datetime
