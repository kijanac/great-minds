"""Cost visibility endpoint."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Query

from great_minds.app.api.dependencies import (
    BrainAccessDep,
    CurrentUser,
    LlmCostServiceDep,
)
from great_minds.app.api.schemas import costs as schemas

router = APIRouter(prefix="/costs", tags=["costs"])


@router.get("")
async def get_costs(
    user: CurrentUser,
    cost_service: LlmCostServiceDep,
    access: BrainAccessDep,
    since: Annotated[datetime | None, Query()] = None,
    until: Annotated[datetime | None, Query()] = None,
    brain_id: Annotated[UUID | None, Query()] = None,
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
