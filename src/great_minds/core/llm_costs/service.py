"""Service helpers for LLM cost events."""

from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.core.llm_costs.repository import (
    CostAggregate,
    LlmCostEventRepository,
)
from great_minds.core.telemetry import wide_event


class LlmCostService:
    def __init__(self, repo: LlmCostEventRepository) -> None:
        self.repo = repo

    async def aggregate(
        self,
        *,
        user_id: uuid.UUID | None = None,
        brain_id: uuid.UUID | None = None,
        since: datetime | None = None,
        until: datetime | None = None,
    ) -> CostAggregate:
        return await self.repo.aggregate(
            user_id=user_id, brain_id=brain_id, since=since, until=until
        )


async def record_wide_event_cost(
    session: AsyncSession,
    *,
    user_id: uuid.UUID | None,
    brain_id: uuid.UUID | None,
) -> None:
    """Persist the current wide_event's accumulated cost as one row.

    Reads ``cost_usd`` (sum of ``api_call`` cost contributions for the
    in-flight request) from the contextvar set by ``init_wide_event``.
    No-op if no wide_event is active or the accumulated cost is zero.

    Call once at end-of-request, right before ``emit_wide_event()`` —
    the same dict that gets logged is the source of truth for what gets
    persisted, so logs and DB carry the same number.
    """
    ctx = wide_event.get()
    if ctx is None:
        return
    raw_cost = ctx.get("cost_usd", 0.0)
    if not raw_cost:
        return
    repo = LlmCostEventRepository(session)
    await repo.record(
        user_id=user_id,
        brain_id=brain_id,
        event_type=ctx.get("event_type", "unknown"),
        cost_usd=Decimal(str(raw_cost)),
        correlation_id=ctx.get("correlation_id"),
    )
