"""Cost aggregation API schemas."""

from __future__ import annotations

from decimal import Decimal

from pydantic import BaseModel


class CostBreakdownItem(BaseModel):
    key: str
    total_usd: Decimal
    event_count: int


class CostAggregateResponse(BaseModel):
    total_usd: Decimal
    event_count: int
    by_vault: list[CostBreakdownItem]
    by_event_type: list[CostBreakdownItem]
