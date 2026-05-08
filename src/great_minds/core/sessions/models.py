"""ORM model for the session listing index.

Session JSONL files remain the authoritative event log. This table is a
minimal query index for list/filter/sort pagination.
"""

import uuid

from sqlalchemy import ForeignKey, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from great_minds.core.db import Base


class SessionRecordORM(Base):
    __tablename__ = "sessions"

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    vault_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("vaults.id", ondelete="CASCADE"),
        primary_key=True,
        index=True,
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        index=True,
    )
    query: Mapped[str] = mapped_column(Text)
    origin: Mapped[dict | None] = mapped_column(JSONB)
    created: Mapped[str] = mapped_column(Text)
    updated: Mapped[str] = mapped_column(Text, index=True)
