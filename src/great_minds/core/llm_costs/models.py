"""ORM for llm_cost_events."""

from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy import DateTime, ForeignKey, Numeric, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from great_minds.core.db import Base


class LlmCostEventORM(Base):
    __tablename__ = "llm_cost_events"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        server_default=func.gen_random_uuid(),
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
    )
    vault_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("vaults.id", ondelete="CASCADE"),
    )
    event_type: Mapped[str] = mapped_column(Text)
    cost_usd: Mapped[Decimal] = mapped_column(Numeric(precision=12, scale=6))
    correlation_id: Mapped[str | None] = mapped_column(Text)
