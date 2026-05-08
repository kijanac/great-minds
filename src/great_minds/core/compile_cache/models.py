"""DB-backed compile cache entries."""

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from great_minds.core.db import Base


class CompileCacheEntryORM(Base):
    __tablename__ = "compile_cache_entries"
    __table_args__ = (UniqueConstraint("vault_id", "phase", "cache_key"),)

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        server_default=func.gen_random_uuid(),
    )
    vault_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("vaults.id", ondelete="CASCADE"),
        index=True,
    )
    phase: Mapped[str] = mapped_column(Text)
    cache_key: Mapped[str] = mapped_column(Text)
    value: Mapped[dict] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
