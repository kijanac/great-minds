"""ORM models for source documents and rendered wiki articles."""

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from great_minds.core.db import Base


class SourceDocumentORM(Base):
    """Queryable registry row for ingested source material."""

    __tablename__ = "source_documents"
    __table_args__ = (UniqueConstraint("vault_id", "file_path"),)

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid()
    )
    vault_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("vaults.id", ondelete="CASCADE"), index=True
    )
    file_path: Mapped[str] = mapped_column(Text)
    file_hash: Mapped[str] = mapped_column(Text)
    body_hash: Mapped[str] = mapped_column(Text)
    etag: Mapped[str | None] = mapped_column(Text)
    title: Mapped[str] = mapped_column(Text)
    author: Mapped[str | None] = mapped_column(Text)
    url: Mapped[str | None] = mapped_column(Text)
    origin: Mapped[str | None] = mapped_column(Text)
    published_date: Mapped[str | None] = mapped_column(Text)
    genre: Mapped[str | None] = mapped_column(Text)
    compiled: Mapped[bool] = mapped_column(Boolean, server_default="false")
    source_type: Mapped[str | None] = mapped_column(Text)
    precis: Mapped[str | None] = mapped_column(Text)
    tags: Mapped[list[str]] = mapped_column(ARRAY(Text))
    doc_metadata: Mapped[dict] = mapped_column("metadata", JSONB, server_default="{}")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class WikiArticleORM(Base):
    """One rendered wiki article per canonical topic.

    ``title`` and ``precis`` are snapshots from the canonical topic
    captured at render time — they live on this row so reads don't
    JOIN topics for display. ``topics`` holds the live editorial
    values; drift between the snapshot and live topic is a queryable
    staleness signal. ``file_path`` / ``file_hash`` / ``body_hash``
    track the on-disk artifact for IO, search indexing, and backlink
    resolution.
    """

    __tablename__ = "wiki_articles"
    __table_args__ = (
        UniqueConstraint("vault_id", "file_path"),
        UniqueConstraint("topic_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid()
    )
    vault_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("vaults.id", ondelete="CASCADE"), index=True
    )
    topic_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("topics.topic_id", ondelete="CASCADE"),
        nullable=False,
    )
    file_path: Mapped[str] = mapped_column(Text)
    file_hash: Mapped[str] = mapped_column(Text)
    body_hash: Mapped[str] = mapped_column(Text)
    title: Mapped[str] = mapped_column(Text)
    precis: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class BacklinkORM(Base):
    """Article-to-article link built by verify from rendered wiki prose."""

    __tablename__ = "backlinks"

    source_article_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("wiki_articles.id", ondelete="CASCADE"),
        primary_key=True,
    )
    target_article_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("wiki_articles.id", ondelete="CASCADE"),
        primary_key=True,
    )
