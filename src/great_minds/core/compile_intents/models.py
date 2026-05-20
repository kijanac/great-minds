"""CompileIntent ORM model."""

from datetime import datetime
from uuid import UUID

from sqlalchemy import DateTime, ForeignKey, Index, text
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column

from great_minds.core.db import Base


class CompileIntentRecord(Base):
    __tablename__ = "compile_intents"
    __table_args__ = (
        # Coalesces concurrent ingests to one pending intent per vault at the
        # DB level. Required by the ON CONFLICT (vault_id) WHERE dispatched_at
        # IS NULL clause in ``IntentRepository.ensure_pending``.
        Index(
            "ix_compile_intents_one_pending",
            "vault_id",
            unique=True,
            postgresql_where=text("dispatched_at IS NULL"),
        ),
        # Reconciler scans pending intents by created_at; partial index keeps
        # the scan bounded as the table grows with dispatched rows.
        Index(
            "ix_compile_intents_pending",
            "created_at",
            postgresql_where=text("dispatched_at IS NULL"),
        ),
    )

    id: Mapped[UUID] = mapped_column(
        PG_UUID, primary_key=True, server_default=text("gen_random_uuid()")
    )
    vault_id: Mapped[UUID] = mapped_column(
        PG_UUID,
        ForeignKey("vaults.id", ondelete="CASCADE"),
    )
    pipeline_run_id: Mapped[UUID | None] = mapped_column(
        PG_UUID,
        ForeignKey("pipeline_runs.id", ondelete="SET NULL"),
        index=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=text("now()"),
    )
    dispatched_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    dispatched_task_id: Mapped[UUID | None] = mapped_column(PG_UUID)
    satisfied_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
