"""Task ORM model."""

from datetime import datetime
from uuid import UUID

from sqlalchemy import DateTime, ForeignKey, Text, text
from sqlalchemy.dialects.postgresql import JSONB, UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column

from great_minds.core.db import Base


class TaskRecordORM(Base):
    __tablename__ = "tasks"

    id: Mapped[UUID] = mapped_column(PG_UUID, primary_key=True)
    vault_id: Mapped[UUID] = mapped_column(
        PG_UUID,
        ForeignKey("vaults.id", ondelete="CASCADE"),
        index=True,
    )
    type: Mapped[str] = mapped_column(Text)
    params: Mapped[dict] = mapped_column(JSONB, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=text("now()"),
    )
