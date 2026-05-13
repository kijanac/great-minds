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


class CostBreakdown(BaseModel):
    """A single bucket in an aggregation query."""

    key: str
    total_usd: Decimal
    event_count: int


class CostAggregate(BaseModel):
    """Aggregation result with per-vault and per-event-type breakdowns."""

    total_usd: Decimal
    event_count: int
    by_vault: list[CostBreakdown]
    by_event_type: list[CostBreakdown]
