"""ORM for ideas (pgvector-backed) and per-idea anchors."""

import uuid
from datetime import datetime

from pgvector.sqlalchemy import Vector
from sqlalchemy import DateTime, ForeignKey, Integer, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from great_minds.core.db import Base
from great_minds.core.llm.providers import EMBEDDING_DIMENSIONS


class IdeaORM(Base):
    """One row per idea extracted from a source document.

    Holds the idea's identity, content (kind/label/description) and its
    embedding vector. Per-anchor records live on the ``anchors`` table.
    Cascades on document deletion via ``source_documents.id`` FK.
    """

    __tablename__ = "ideas"

    idea_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    vault_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    document_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("source_documents.id", ondelete="CASCADE"),
        index=True,
    )
    kind: Mapped[str] = mapped_column(Text)
    label: Mapped[str] = mapped_column(Text)
    description: Mapped[str] = mapped_column(Text)
    embedding: Mapped[list[float]] = mapped_column(Vector(EMBEDDING_DIMENSIONS))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    anchors: Mapped[list["AnchorORM"]] = relationship(
        back_populates="idea",
        cascade="all, delete-orphan",
        order_by="AnchorORM.position",
    )


class AnchorORM(Base):
    """One claim/quote pair under an idea. Order-as-identity.

    ``position`` is the 0-indexed slot in the idea's anchor list. Render
    numbers anchors sequentially across an article, so the only identity
    we need to preserve is per-idea ordering.
    """

    __tablename__ = "anchors"

    idea_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("ideas.idea_id", ondelete="CASCADE"),
        primary_key=True,
    )
    position: Mapped[int] = mapped_column(Integer, primary_key=True)
    claim: Mapped[str] = mapped_column(Text)
    quote: Mapped[str] = mapped_column(Text)
    chunk_index: Mapped[int | None] = mapped_column(Integer)

    idea: Mapped[IdeaORM] = relationship(back_populates="anchors")
