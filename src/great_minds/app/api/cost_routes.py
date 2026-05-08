"""Cost visibility endpoints."""

from datetime import datetime
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Query

from great_minds.app.api.dependencies import CurrentUser, LlmCostServiceDep
from great_minds.app.api.schemas import costs as schemas

router = APIRouter(prefix="/costs", tags=["costs"])
vault_router = APIRouter(prefix="/costs", tags=["costs"])


@router.get("")
async def get_user_costs(
    user: CurrentUser,
    cost_service: LlmCostServiceDep,
    since: Annotated[datetime | None, Query()] = None,
    until: Annotated[datetime | None, Query()] = None,
) -> schemas.CostAggregateResponse:
    """Aggregate the caller's own user-attributed LLM costs across vaults."""
    aggregate = await cost_service.aggregate(user_id=user.id, since=since, until=until)
    return _cost_response(aggregate)


@vault_router.get("")
async def get_vault_costs(
    vault_id: UUID,
    cost_service: LlmCostServiceDep,
    since: Annotated[datetime | None, Query()] = None,
    until: Annotated[datetime | None, Query()] = None,
) -> schemas.CostAggregateResponse:
    """Aggregate all cost-bearing events for a vault.

    Membership is enforced by the vault-scoped router in ``v1``.
    """
    aggregate = await cost_service.aggregate(
        vault_id=vault_id, since=since, until=until
    )
    return _cost_response(aggregate)


def _cost_response(aggregate) -> schemas.CostAggregateResponse:
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
