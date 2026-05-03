"""CompileIntent ORM model."""

from datetime import datetime
from uuid import UUID

from sqlalchemy import DateTime, ForeignKey, text
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column

from great_minds.core.db import Base


class CompileIntentRecord(Base):
    __tablename__ = "compile_intents"

    id: Mapped[UUID] = mapped_column(
        PG_UUID, primary_key=True, server_default=text("gen_random_uuid()")
    )
    vault_id: Mapped[UUID] = mapped_column(
        PG_UUID,
        ForeignKey("vaults.id", ondelete="CASCADE"),
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=text("now()"),
    )
    dispatched_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    dispatched_task_id: Mapped[UUID | None] = mapped_column(PG_UUID)
    satisfied_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
