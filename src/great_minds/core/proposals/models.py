import enum
import uuid
from datetime import datetime

from sqlalchemy import DateTime, Enum, ForeignKey, String, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from great_minds.core.db import Base


class ProposalStatus(enum.StrEnum):
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"


class SourceProposal(Base):
    __tablename__ = "source_proposals"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    brain_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("brains.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    status: Mapped[ProposalStatus] = mapped_column(Enum(ProposalStatus, name="proposal_status"), default=ProposalStatus.PENDING)
    content_type: Mapped[str] = mapped_column(String(50))
    title: Mapped[str | None] = mapped_column(Text)
    author: Mapped[str | None] = mapped_column(Text)
    storage_path: Mapped[str] = mapped_column(Text)
    reviewed_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    brain: Mapped["BrainORM"] = relationship("BrainORM")
    user: Mapped["User"] = relationship("User", foreign_keys=[user_id])
    reviewer: Mapped["User | None"] = relationship("User", foreign_keys=[reviewed_by])
