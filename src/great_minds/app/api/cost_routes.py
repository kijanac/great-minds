"""Cost visibility endpoint."""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from fastapi import APIRouter, Depends, Query

from great_minds.app.api.dependencies import (
    CurrentUser,
    get_brain_access,
    get_llm_cost_service,
)
from great_minds.app.api.schemas import costs as schemas
from great_minds.core.brains import BrainAccess
from great_minds.core.llm_costs import LlmCostService

router = APIRouter(prefix="/costs", tags=["costs"])


@router.get("")
async def get_costs(
    user: CurrentUser,
    cost_service: LlmCostService = Depends(get_llm_cost_service),
    access: BrainAccess = Depends(get_brain_access),
    since: datetime | None = Query(None),
    until: datetime | None = Query(None),
    brain_id: UUID | None = Query(None),
) -> schemas.CostAggregateResponse:
    """LLM cost totals.

    With ``brain_id``: aggregate every cost-bearing event for that brain
    (compiles + queries from any member). Caller must be a member.
    Without ``brain_id``: aggregate the caller's own user-attributed
    events across all brains.
    """
    if brain_id is not None:
        await access.require_member(brain_id, user.id)
        aggregate = await cost_service.aggregate(
            brain_id=brain_id, since=since, until=until
        )
    else:
        aggregate = await cost_service.aggregate(
            user_id=user.id, since=since, until=until
        )

    return schemas.CostAggregateResponse(
        total_usd=aggregate.total_usd,
        event_count=aggregate.event_count,
        by_brain=[
            schemas.CostBreakdownItem(
                key=b.key, total_usd=b.total_usd, event_count=b.event_count
            )
            for b in aggregate.by_brain
        ],
        by_event_type=[
            schemas.CostBreakdownItem(
                key=b.key, total_usd=b.total_usd, event_count=b.event_count
            )
            for b in aggregate.by_event_type
        ],
    )
