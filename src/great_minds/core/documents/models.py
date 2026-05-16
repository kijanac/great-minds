"""ORM models for source documents and rendered wiki articles."""

import uuid
from datetime import datetime

import sqlalchemy as sa
from sqlalchemy import (
    DateTime,
    ForeignKey,
    Integer,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from great_minds.core.db import Base


class SourceDocumentORM(Base):
    """Queryable registry row for ingested source material.

    Three column zones:

    1. Identity / mechanically-known: set at ingest from what the system
       knows for free (paths, hashes, etag, source_type, url, origin).
       Immutable after ingest.
    2. Per-source-kind provenance: set at ingest by system flows
       (session promotion, user-suggestion). Sparse — NULL for the
       common case (source_type='document').
    3. LLM-derived: set/refreshed by the extract phase on every compile.
       NULL until first compile.
    """

    __tablename__ = "source_documents"
    __table_args__ = (UniqueConstraint("vault_id", "file_path"),)

    # --- Zone 1: identity / mechanically-known ---
    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    vault_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("vaults.id")
    )
    file_path: Mapped[str] = mapped_column(Text)
    file_hash: Mapped[str] = mapped_column(Text)
    body_hash: Mapped[str] = mapped_column(Text)
    # SHA-256 of the original uploaded bytes, captured client-side at
    # pick time. Used by the ingest dupe-check pre-flight so the UI can
    # mark a file as "already in this vault" before upload.
    client_hash: Mapped[str | None] = mapped_column(Text)
    etag: Mapped[str | None] = mapped_column(Text)
    source_type: Mapped[str] = mapped_column(Text)  # 'document' | 'session' | 'user'
    url: Mapped[str | None] = mapped_column(Text)
    origin: Mapped[str | None] = mapped_column(Text)

    # --- Zone 2: per-source-kind provenance (sparse, system-set) ---
    # source_type='session' (promoted chat exchange):
    provenance_session_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    provenance_exchange_id: Mapped[str | None] = mapped_column(Text)
    provenance_session_query: Mapped[str | None] = mapped_column(Text)
    # Additional fields when the session was BTW-spun from a wiki article:
    provenance_source_doc_path: Mapped[str | None] = mapped_column(Text)
    provenance_source_anchor: Mapped[str | None] = mapped_column(Text)
    provenance_source_paragraph_index: Mapped[int | None] = mapped_column(Integer)
    # source_type='user' (anchored suggestion):
    provenance_anchored_to: Mapped[str | None] = mapped_column(Text)
    provenance_anchored_section: Mapped[str | None] = mapped_column(Text)
    provenance_intent: Mapped[str | None] = mapped_column(Text)

    # --- Zone 3: LLM-derived (NULL until first compile) ---
    title: Mapped[str | None] = mapped_column(Text)
    precis: Mapped[str | None] = mapped_column(Text)
    author: Mapped[str | None] = mapped_column(Text)
    published_date: Mapped[str | None] = mapped_column(Text)
    genre: Mapped[str | None] = mapped_column(Text)
    tags: Mapped[list[str]] = mapped_column(
        ARRAY(Text), server_default=sa.text("ARRAY[]::text[]")
    )
    # Vault-configured enriched fields. Shape is whatever the vault's
    # config.yaml `metadata:` block declared; the extract LLM fills per
    # compile. Surfaced in partition/synthesize editorial context.
    derived_extras: Mapped[dict] = mapped_column(JSONB, server_default="{}")

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class WikiArticleORM(Base):
    """One rendered wiki article per canonical topic.

    ``title`` and ``precis`` are snapshots from the canonical topic
    captured at render time. They live on this row so reads don't JOIN
    topics for display; drift between snapshot and live topic is a
    queryable staleness signal. ``file_path`` / ``file_hash`` /
    ``body_hash`` track the on-disk artifact for IO, search indexing,
    and backlink resolution.
    """

    __tablename__ = "wiki_articles"
    __table_args__ = (UniqueConstraint("vault_id", "topic_id"),)

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    vault_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("vaults.id")
    )
    topic_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("topics.topic_id")
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
