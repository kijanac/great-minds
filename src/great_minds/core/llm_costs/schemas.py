"""Pydantic schemas for LLM cost events."""


import uuid
from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict


class LlmCostEvent(BaseModel):
    """Single persisted cost row."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    created_at: datetime
    user_id: uuid.UUID | None
    vault_id: uuid.UUID | None
    event_type: str
    cost_usd: Decimal
    correlation_id: str | None
