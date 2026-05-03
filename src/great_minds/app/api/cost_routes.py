"""Cost visibility endpoint."""


from datetime import datetime
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Query

from great_minds.app.api.dependencies import (
    VaultAccessDep,
    CurrentUser,
    LlmCostServiceDep,
)
from great_minds.app.api.schemas import costs as schemas

router = APIRouter(prefix="/costs", tags=["costs"])


@router.get("")
async def get_costs(
    user: CurrentUser,
    cost_service: LlmCostServiceDep,
    access: VaultAccessDep,
    since: Annotated[datetime | None, Query()] = None,
    until: Annotated[datetime | None, Query()] = None,
    vault_id: Annotated[UUID | None, Query()] = None,
) -> schemas.CostAggregateResponse:
    """LLM cost totals.

    With ``vault_id``: aggregate every cost-bearing event for that vault
    (compiles + queries from any member). Caller must be a member.
    Without ``vault_id``: aggregate the caller's own user-attributed
    events across all vaults.
    """
    if vault_id is not None:
        await access.require_member(vault_id, user.id)
        aggregate = await cost_service.aggregate(
            vault_id=vault_id, since=since, until=until
        )
    else:
        aggregate = await cost_service.aggregate(
            user_id=user.id, since=since, until=until
        )

    return schemas.CostAggregateResponse(
        total_usd=aggregate.total_usd,
        event_count=aggregate.event_count,
        by_vault=[
            schemas.CostBreakdownItem(
                key=b.key, total_usd=b.total_usd, event_count=b.event_count
            )
            for b in aggregate.by_vault
        ],
        by_event_type=[
            schemas.CostBreakdownItem(
                key=b.key, total_usd=b.total_usd, event_count=b.event_count
            )
            for b in aggregate.by_event_type
        ],
    )
