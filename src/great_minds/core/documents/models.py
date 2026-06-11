"""ORM models for source documents and rendered wiki articles."""

import uuid
from datetime import datetime

import sqlalchemy as sa
from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Index,
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
    __table_args__ = (
        UniqueConstraint("vault_id", "file_path"),
        # Partial index for the dupe-check preflight: "is this client_hash
        # already in this vault?" Only NOT NULL rows matter, so the partial
        # WHERE clause keeps the index tight.
        Index(
            "ix_source_documents_vault_client_hash",
            "vault_id",
            "client_hash",
            postgresql_where=sa.text("client_hash IS NOT NULL"),
        ),
    )

    # --- Zone 1: identity / mechanically-known ---
    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    vault_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("vaults.id", ondelete="CASCADE"),
        index=True,
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
    # One article per topic. topic_id is globally unique (topics PK), so a
    # single-column constraint suffices — and the render upsert targets
    # ON CONFLICT (topic_id), which requires exactly this.
    __table_args__ = (
        UniqueConstraint("topic_id"),
        # Provenance lookup: "which articles did this compile build?"
        # Partial — the column is NULL for pre-provenance rows and only
        # the per-run delta query reads it.
        Index(
            "ix_wiki_articles_render_run_id",
            "render_run_id",
            postgresql_where=sa.text("render_run_id IS NOT NULL"),
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    vault_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("vaults.id", ondelete="CASCADE"),
        index=True,
    )
    topic_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("topics.topic_id", ondelete="CASCADE"),
    )
    file_path: Mapped[str] = mapped_column(Text)
    file_hash: Mapped[str] = mapped_column(Text)
    body_hash: Mapped[str] = mapped_column(Text)
    # True once the topic is archived (file moved under archive/, repointed
    # by validate). Archived rows are excluded from the wiki list and orphan
    # lint; the row survives so backlinks and supersession reads still resolve.
    archived: Mapped[bool] = mapped_column(Boolean, server_default=sa.false())
    title: Mapped[str] = mapped_column(Text)
    precis: Mapped[str] = mapped_column(Text)
    # 3-6 LLM-generated tags for the rendered article, mirrored onto the
    # row so wiki reads and tag queries don't have to parse frontmatter.
    tags: Mapped[list[str]] = mapped_column(
        ARRAY(Text), server_default=sa.text("ARRAY[]::text[]")
    )
    # The pipeline run that last rendered (or re-materialized) this article.
    # SET NULL, never CASCADE: purging a run must not delete the article it
    # produced — provenance is lost, the wiki survives.
    render_run_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("pipeline_runs.id", ondelete="SET NULL"),
    )
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
