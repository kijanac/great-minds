"""Pydantic schemas for LLM cost events."""

from decimal import Decimal

from pydantic import BaseModel


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
