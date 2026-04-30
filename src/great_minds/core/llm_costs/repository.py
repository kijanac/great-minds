"""Repository for llm_cost_events. Persistence + aggregation queries."""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal

from sqlalchemy import func, insert, select
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.core.llm_costs.models import LlmCostEventORM


@dataclass(frozen=True)
class CostBreakdown:
    """A single bucket in an aggregation query."""

    key: str
    total_usd: Decimal
    event_count: int


@dataclass(frozen=True)
class CostAggregate:
    """Aggregation result with per-brain and per-event-type breakdowns."""

    total_usd: Decimal
    event_count: int
    by_brain: list[CostBreakdown]
    by_event_type: list[CostBreakdown]


class LlmCostEventRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def record(
        self,
        *,
        user_id: uuid.UUID | None,
        brain_id: uuid.UUID | None,
        event_type: str,
        cost_usd: Decimal,
        correlation_id: str | None,
    ) -> None:
        await self.session.execute(
            insert(LlmCostEventORM).values(
                user_id=user_id,
                brain_id=brain_id,
                event_type=event_type,
                cost_usd=cost_usd,
                correlation_id=correlation_id,
            )
        )

    async def aggregate(
        self,
        *,
        user_id: uuid.UUID | None = None,
        brain_id: uuid.UUID | None = None,
        since: datetime | None = None,
        until: datetime | None = None,
    ) -> CostAggregate:
        """Sum cost across all events matching the filters.

        ``user_id`` and ``brain_id`` filter by exact match. ``None``
        means "no filter on that field" — pass the current user at the
        route level if you want to scope to a single user.
        """
        conditions = []
        if user_id is not None:
            conditions.append(LlmCostEventORM.user_id == user_id)
        if brain_id is not None:
            conditions.append(LlmCostEventORM.brain_id == brain_id)
        if since is not None:
            conditions.append(LlmCostEventORM.created_at >= since)
        if until is not None:
            conditions.append(LlmCostEventORM.created_at <= until)

        total_stmt = select(
            func.coalesce(func.sum(LlmCostEventORM.cost_usd), 0),
            func.count(LlmCostEventORM.id),
        ).where(*conditions)
        total_row = (await self.session.execute(total_stmt)).one()
        total_usd: Decimal = Decimal(total_row[0])
        event_count: int = int(total_row[1])

        brain_stmt = (
            select(
                LlmCostEventORM.brain_id,
                func.coalesce(func.sum(LlmCostEventORM.cost_usd), 0),
                func.count(LlmCostEventORM.id),
            )
            .where(*conditions)
            .group_by(LlmCostEventORM.brain_id)
            .order_by(func.sum(LlmCostEventORM.cost_usd).desc())
        )
        by_brain = [
            CostBreakdown(
                key=str(row[0]) if row[0] is not None else "(no-brain)",
                total_usd=Decimal(row[1]),
                event_count=int(row[2]),
            )
            for row in (await self.session.execute(brain_stmt)).all()
        ]

        type_stmt = (
            select(
                LlmCostEventORM.event_type,
                func.coalesce(func.sum(LlmCostEventORM.cost_usd), 0),
                func.count(LlmCostEventORM.id),
            )
            .where(*conditions)
            .group_by(LlmCostEventORM.event_type)
            .order_by(func.sum(LlmCostEventORM.cost_usd).desc())
        )
        by_event_type = [
            CostBreakdown(
                key=row[0],
                total_usd=Decimal(row[1]),
                event_count=int(row[2]),
            )
            for row in (await self.session.execute(type_stmt)).all()
        ]

        return CostAggregate(
            total_usd=total_usd,
            event_count=event_count,
            by_brain=by_brain,
            by_event_type=by_event_type,
        )
