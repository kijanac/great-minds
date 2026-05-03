"""ORM models for the documents index."""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from great_minds.core.db import Base


class DocumentORM(Base):
    __tablename__ = "documents"
    __table_args__ = (UniqueConstraint("vault_id", "file_path"),)

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
    file_path: Mapped[str] = mapped_column(Text)
    file_hash: Mapped[str] = mapped_column(Text)
    # sha256 of body only (post-frontmatter, post-anchor-injection). Used as
    # extract's cache key without re-reading raw bytes from storage.
    body_hash: Mapped[str] = mapped_column(Text)
    title: Mapped[str] = mapped_column(Text, server_default="")
    author: Mapped[str | None] = mapped_column(Text)
    url: Mapped[str | None] = mapped_column(Text)
    origin: Mapped[str | None] = mapped_column(Text)
    published_date: Mapped[str | None] = mapped_column(Text)
    genre: Mapped[str | None] = mapped_column(Text)
    compiled: Mapped[bool] = mapped_column(Boolean, server_default="false")
    doc_kind: Mapped[str] = mapped_column(Text, server_default="raw")
    # source_type is the vault-config metadata bucket for raw docs
    # (texts/news/ideas). It has no meaning for rendered wiki articles,
    # so those rows set source_type = NULL.
    source_type: Mapped[str | None] = mapped_column(Text)
    precis: Mapped[str | None] = mapped_column(Text)
    extra_metadata: Mapped[dict] = mapped_column(
        "metadata", JSONB, server_default="{}"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class DocumentTag(Base):
    __tablename__ = "document_tags"

    document_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("documents.id", ondelete="CASCADE"),
        primary_key=True,
    )
    tag: Mapped[str] = mapped_column(Text, primary_key=True, index=True)


class BacklinkORM(Base):
    """Article-to-article link derived from rendered wiki prose."""

    __tablename__ = "backlinks"

    source_document_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("documents.id", ondelete="CASCADE"),
        primary_key=True,
    )
    target_document_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("documents.id", ondelete="CASCADE"),
        primary_key=True,
    )
