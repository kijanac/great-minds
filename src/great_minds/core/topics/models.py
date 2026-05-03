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
    __table_args__ = (UniqueConstraint("vault_id", "slug"),)

    topic_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    vault_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("vaults.id", ondelete="CASCADE"),
        index=True,
    )
    slug: Mapped[str] = mapped_column(Text)
    title: Mapped[str] = mapped_column(Text)
    description: Mapped[str] = mapped_column(Text)
    article_status: Mapped[str] = mapped_column(Text, server_default="no_article")
    compiled_from_hash: Mapped[str | None] = mapped_column(Text)
    rendered_from_hash: Mapped[str | None] = mapped_column(Text)
    supersedes: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    superseded_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
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
    shared_ideas: Mapped[int] = mapped_column(Integer)
    jaccard: Mapped[float] = mapped_column(Double)
