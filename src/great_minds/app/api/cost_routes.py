"""Cost visibility endpoints."""

from datetime import datetime
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Query

from great_minds.app.api.dependencies import CurrentUser, LlmCostServiceDep
from great_minds.core.llm_costs import CostAggregate

router = APIRouter(prefix="/costs", tags=["costs"])
vault_router = APIRouter(prefix="/costs", tags=["costs"])


@router.get("")
async def get_user_costs(
    user: CurrentUser,
    cost_service: LlmCostServiceDep,
    since: Annotated[datetime | None, Query()] = None,
    until: Annotated[datetime | None, Query()] = None,
) -> CostAggregate:
    """Aggregate the caller's own user-attributed LLM costs across vaults."""
    return await cost_service.aggregate(user_id=user.id, since=since, until=until)


@vault_router.get("")
async def get_vault_costs(
    vault_id: UUID,
    cost_service: LlmCostServiceDep,
    since: Annotated[datetime | None, Query()] = None,
    until: Annotated[datetime | None, Query()] = None,
) -> CostAggregate:
    """Aggregate all cost-bearing events for a vault.

    Membership is enforced by the vault-scoped router in ``v1``.
    """
    return await cost_service.aggregate(vault_id=vault_id, since=since, until=until)
