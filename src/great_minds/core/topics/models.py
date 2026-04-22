"""ORM models for the topic registry and its derived tables."""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    DateTime,
    Double,
    ForeignKey,
    Integer,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from great_minds.core.db import Base


class TopicORM(Base):
    __tablename__ = "topics"
    __table_args__ = (UniqueConstraint("brain_id", "slug"),)

    topic_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    brain_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("brains.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    slug: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    article_status: Mapped[str] = mapped_column(
        Text, nullable=False, server_default="no_article"
    )
    compiled_from_hash: Mapped[str | None] = mapped_column(Text, nullable=True)
    rendered_from_hash: Mapped[str | None] = mapped_column(Text, nullable=True)
    supersedes: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    superseded_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class TopicMembershipORM(Base):
    __tablename__ = "topic_membership"

    topic_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("topics.topic_id", ondelete="CASCADE"),
        primary_key=True,
    )
    idea_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)


class TopicLinkORM(Base):
    __tablename__ = "topic_links"

    source_topic_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("topics.topic_id", ondelete="CASCADE"),
        primary_key=True,
    )
    target_topic_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("topics.topic_id", ondelete="CASCADE"),
        primary_key=True,
    )


class TopicRelatedORM(Base):
    __tablename__ = "topic_related"

    topic_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("topics.topic_id", ondelete="CASCADE"),
        primary_key=True,
    )
    related_topic_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("topics.topic_id", ondelete="CASCADE"),
        primary_key=True,
    )
    shared_ideas: Mapped[int] = mapped_column(Integer, nullable=False)
    jaccard: Mapped[float] = mapped_column(Double, nullable=False)
