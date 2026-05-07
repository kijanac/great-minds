"""PipelineRun ORM model."""

from datetime import datetime
from uuid import UUID

from sqlalchemy import DateTime, ForeignKey, Text, text
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column

from great_minds.core.db import Base


class PipelineRunRecord(Base):
    __tablename__ = "pipeline_runs"

    id: Mapped[UUID] = mapped_column(PG_UUID, primary_key=True)
    vault_id: Mapped[UUID] = mapped_column(
        PG_UUID,
        ForeignKey("vaults.id", ondelete="CASCADE"),
        index=True,
    )

    trigger: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text, default="pending")

    current_phase: Mapped[str] = mapped_column(Text, default="")
    phase_status: Mapped[str] = mapped_column(Text, default="")
    progress_done: Mapped[int] = mapped_column(default=0)
    progress_total: Mapped[int] = mapped_column(default=0)
    progress_failed: Mapped[int] = mapped_column(default=0)
    progress_message: Mapped[str] = mapped_column(Text, default="")
    error: Mapped[str | None] = mapped_column(Text)

    ingest_task_id: Mapped[UUID | None] = mapped_column(PG_UUID)
    compile_intent_id: Mapped[UUID | None] = mapped_column(PG_UUID)
    compile_task_id: Mapped[UUID | None] = mapped_column(PG_UUID)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=text("now()"),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=text("now()"),
    )
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
