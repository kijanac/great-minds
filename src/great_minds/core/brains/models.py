from __future__ import annotations

import enum
import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import DateTime, Enum, ForeignKey, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from great_minds.core.db import Base

if TYPE_CHECKING:
    from great_minds.core.users.models import User


class MemberRole(enum.StrEnum):
    OWNER = "owner"
    EDITOR = "editor"
    VIEWER = "viewer"


class BrainORM(Base):
    __tablename__ = "brains"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    name: Mapped[str] = mapped_column(String(255))
    owner_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    owner: Mapped["User"] = relationship("User")
    memberships: Mapped[list["BrainMembership"]] = relationship(
        "BrainMembership", back_populates="brain", cascade="all, delete-orphan"
    )


class BrainMembership(Base):
    __tablename__ = "brain_memberships"
    __table_args__ = (UniqueConstraint("brain_id", "user_id"),)

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    brain_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("brains.id", ondelete="CASCADE")
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE")
    )
    role: Mapped[MemberRole] = mapped_column(Enum(MemberRole, name="member_role"))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    brain: Mapped["BrainORM"] = relationship("BrainORM", back_populates="memberships")
    user: Mapped["User"] = relationship("User", back_populates="memberships")
