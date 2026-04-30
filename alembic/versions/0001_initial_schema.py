"""initial schema

Full schema for the seven-phase pipeline: users, auth, brains,
memberships, proposals, tasks, compile_intents (outbox), search index,
documents, idea_embeddings, topics + topic_membership + topic_links +
topic_related, backlinks (keyed by document_id), and the absurd task queue.

Revision ID: 0001
Revises:
Create Date: 2026-04-17
"""

from pathlib import Path
from typing import Sequence, Union

import psycopg
from alembic import op
import sqlalchemy as sa
from sqlalchemy import text
from sqlalchemy.dialects.postgresql import JSONB


revision: str = "0001"
down_revision: Union[str, Sequence[str], None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # -- Extensions --------------------------------------------------------
    op.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))

    # -- Users & auth ------------------------------------------------------
    op.create_table(
        "users",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("email", sa.String(length=320), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_users_email", "users", ["email"], unique=True)

    op.create_table(
        "api_keys",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("key_hash", sa.String(length=64), nullable=False),
        sa.Column("label", sa.Text(), nullable=False),
        sa.Column("revoked", sa.Boolean(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_api_keys_key_hash", "api_keys", ["key_hash"], unique=True)

    op.create_table(
        "auth_codes",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("email", sa.String(length=320), nullable=False),
        sa.Column("code_hash", sa.String(length=64), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used", sa.Boolean(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_auth_codes_email", "auth_codes", ["email"], unique=False)

    op.create_table(
        "refresh_tokens",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked", sa.Boolean(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_refresh_tokens_token_hash", "refresh_tokens", ["token_hash"], unique=True
    )

    # -- Brains & memberships ----------------------------------------------
    op.create_table(
        "brains",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("owner_id", sa.UUID(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_table(
        "brain_memberships",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("brain_id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column(
            "role",
            sa.Enum("OWNER", "EDITOR", "VIEWER", name="member_role"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["brain_id"], ["brains.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("brain_id", "user_id"),
    )

    # -- Source proposals ---------------------------------------------------
    op.create_table(
        "source_proposals",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("brain_id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column(
            "status",
            sa.Enum("PENDING", "APPROVED", "REJECTED", name="proposal_status"),
            nullable=False,
        ),
        sa.Column("content_type", sa.String(length=50), nullable=False),
        sa.Column("title", sa.Text(), nullable=True),
        sa.Column("author", sa.Text(), nullable=True),
        sa.Column("storage_path", sa.Text(), nullable=False),
        sa.Column("reviewed_by", sa.UUID(), nullable=True),
        sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["brain_id"], ["brains.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["reviewed_by"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_source_proposals_brain_id", "source_proposals", ["brain_id"], unique=False
    )

    # -- Tasks -------------------------------------------------------------
    op.create_table(
        "tasks",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("brain_id", sa.UUID(), nullable=False),
        sa.Column("type", sa.Text(), nullable=False),
        sa.Column("params", JSONB(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["brain_id"], ["brains.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_tasks_brain_id", "tasks", ["brain_id"], unique=False)

    # -- Compile intents (outbox: domain-change → eventual compile) --------
    # Lifecycle: pending → dispatched → satisfied. The partial unique index
    # on (brain_id) WHERE dispatched_at IS NULL coalesces concurrent ingests
    # to one pending intent per brain, enforced at the DB level.
    op.create_table(
        "compile_intents",
        sa.Column(
            "id",
            sa.UUID(),
            nullable=False,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("brain_id", sa.UUID(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("dispatched_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("dispatched_task_id", sa.UUID(), nullable=True),
        sa.Column("satisfied_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["brain_id"], ["brains.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_compile_intents_one_pending",
        "compile_intents",
        ["brain_id"],
        unique=True,
        postgresql_where=sa.text("dispatched_at IS NULL"),
    )
    op.create_index(
        "ix_compile_intents_pending",
        "compile_intents",
        ["created_at"],
        postgresql_where=sa.text("dispatched_at IS NULL"),
    )
    op.create_index(
        "ix_compile_intents_dispatched_unsatisfied",
        "compile_intents",
        ["dispatched_at"],
        postgresql_where=sa.text(
            "dispatched_at IS NOT NULL AND satisfied_at IS NULL"
        ),
    )

    # -- LLM cost events (one row per cost-bearing wide_event) ------------
    # Sink for billing/quota aggregation. Source-of-truth lives upstream
    # in the wide_event contextvar (accumulated via accumulate_cost from
    # api_call); this table is the persisted readout at end-of-request.
    op.create_table(
        "llm_cost_events",
        sa.Column(
            "id",
            sa.UUID(),
            nullable=False,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("user_id", sa.UUID(), nullable=True),
        sa.Column("brain_id", sa.UUID(), nullable=True),
        sa.Column("event_type", sa.Text(), nullable=False),
        sa.Column("cost_usd", sa.Numeric(precision=12, scale=6), nullable=False),
        sa.Column("correlation_id", sa.Text(), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["brain_id"], ["brains.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_llm_cost_events_user_created",
        "llm_cost_events",
        ["user_id", "created_at"],
    )
    op.create_index(
        "ix_llm_cost_events_brain_created",
        "llm_cost_events",
        ["brain_id", "created_at"],
    )

    # -- Search index (pgvector + tsvector) --------------------------------
    op.execute(
        text("""
        CREATE TABLE search_index (
            id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            brain_id    UUID NOT NULL REFERENCES brains(id) ON DELETE CASCADE,
            path        TEXT NOT NULL,
            chunk_index INTEGER NOT NULL DEFAULT 0,
            heading     TEXT NOT NULL DEFAULT '',
            body        TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            tsv         tsvector NOT NULL,
            embedding   vector(1024),
            updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

            UNIQUE (brain_id, path, chunk_index)
        )
    """)
    )
    op.execute(text("CREATE INDEX ix_search_index_brain_id ON search_index (brain_id)"))
    op.execute(text("CREATE INDEX ix_search_index_tsv ON search_index USING GIN (tsv)"))
    op.execute(
        text(
            "CREATE INDEX ix_search_index_embedding ON search_index USING hnsw (embedding vector_cosine_ops)"
        )
    )

    # -- Documents (queryable projection of frontmatter) -------------------
    op.create_table(
        "documents",
        sa.Column(
            "id",
            sa.UUID(),
            nullable=False,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("brain_id", sa.UUID(), nullable=False),
        sa.Column("file_path", sa.Text(), nullable=False),
        sa.Column("file_hash", sa.Text(), nullable=False),
        sa.Column("body_hash", sa.Text(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False, server_default=""),
        sa.Column("author", sa.Text(), nullable=True),
        sa.Column("url", sa.Text(), nullable=True),
        sa.Column("origin", sa.Text(), nullable=True),
        sa.Column("published_date", sa.Text(), nullable=True),
        sa.Column("genre", sa.Text(), nullable=True),
        sa.Column("compiled", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("doc_kind", sa.Text(), nullable=False, server_default="raw"),
        # source_type is the brain-config bucket (texts/news/ideas) for
        # raw docs; NULL for rendered wiki articles since the axis
        # doesn't apply to generated outputs.
        sa.Column("source_type", sa.Text(), nullable=True),
        sa.Column("precis", sa.Text(), nullable=True),
        sa.Column("metadata", JSONB(), nullable=False, server_default="{}"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["brain_id"], ["brains.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("brain_id", "file_path"),
    )
    op.create_index("ix_documents_brain_id", "documents", ["brain_id"])
    op.create_index("ix_documents_published_date", "documents", ["published_date"])
    op.create_index("ix_documents_author", "documents", ["author"])
    op.create_index("ix_documents_compiled", "documents", ["compiled"])
    op.create_index("ix_documents_doc_kind", "documents", ["doc_kind"])
    op.execute(
        text("CREATE INDEX ix_documents_metadata_gin ON documents USING GIN (metadata)")
    )

    # -- Junction: document_tags -------------------------------------------
    op.create_table(
        "document_tags",
        sa.Column("document_id", sa.UUID(), nullable=False),
        sa.Column("tag", sa.Text(), nullable=False),
        sa.ForeignKeyConstraint(["document_id"], ["documents.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("document_id", "tag"),
    )
    op.create_index("ix_document_tags_tag", "document_tags", ["tag"])

    # -- Idea embeddings (per-Idea vectors, pgvector-backed) ---------------
    op.execute(
        text(
            """
            CREATE TABLE idea_embeddings (
                idea_id       uuid PRIMARY KEY,
                brain_id      uuid NOT NULL,
                document_id   uuid NOT NULL,
                kind          text NOT NULL,
                label         text NOT NULL,
                description   text NOT NULL,
                embedding     vector(1024) NOT NULL,
                created_at    timestamptz NOT NULL DEFAULT now()
            )
            """
        )
    )
    op.execute(
        text("CREATE INDEX ix_idea_embeddings_brain_id ON idea_embeddings (brain_id)")
    )
    op.execute(
        text(
            "CREATE INDEX ix_idea_embeddings_document_id "
            "ON idea_embeddings (document_id)"
        )
    )
    op.execute(
        text(
            "CREATE INDEX ix_idea_embeddings_embedding ON idea_embeddings "
            "USING hnsw (embedding vector_cosine_ops)"
        )
    )

    # -- Topics (canonical theme registry) ---------------------------------
    op.execute(
        text(
            """
            CREATE TABLE topics (
                topic_id            uuid PRIMARY KEY,
                brain_id            uuid NOT NULL REFERENCES brains(id) ON DELETE CASCADE,
                slug                text NOT NULL,
                title               text NOT NULL,
                description         text NOT NULL,
                article_status      text NOT NULL DEFAULT 'no_article',
                compiled_from_hash  text NULL,
                rendered_from_hash  text NULL,
                supersedes          uuid NULL,
                superseded_by       uuid NULL,
                created_at          timestamptz NOT NULL DEFAULT now(),
                updated_at          timestamptz NOT NULL DEFAULT now(),
                UNIQUE (brain_id, slug)
            )
            """
        )
    )
    op.execute(text("CREATE INDEX ix_topics_brain_id ON topics (brain_id)"))
    op.execute(
        text("CREATE INDEX ix_topics_article_status ON topics (article_status)")
    )

    # -- Topic membership (topic <-> idea edges, derived) ------------------
    op.execute(
        text(
            """
            CREATE TABLE topic_membership (
                topic_id   uuid NOT NULL REFERENCES topics(topic_id) ON DELETE CASCADE,
                idea_id    uuid NOT NULL,
                PRIMARY KEY (topic_id, idea_id)
            )
            """
        )
    )
    op.execute(
        text(
            "CREATE INDEX ix_topic_membership_idea_id "
            "ON topic_membership (idea_id)"
        )
    )

    # -- Topic links (intentional citations from reduce's link_targets) ---
    op.execute(
        text(
            """
            CREATE TABLE topic_links (
                source_topic_id  uuid NOT NULL REFERENCES topics(topic_id) ON DELETE CASCADE,
                target_topic_id  uuid NOT NULL REFERENCES topics(topic_id) ON DELETE CASCADE,
                PRIMARY KEY (source_topic_id, target_topic_id)
            )
            """
        )
    )
    op.execute(
        text(
            "CREATE INDEX ix_topic_links_target "
            "ON topic_links (target_topic_id)"
        )
    )

    # -- Topic related (shared-idea Jaccard, for sidebar UI) ---------------
    op.execute(
        text(
            """
            CREATE TABLE topic_related (
                topic_id         uuid NOT NULL REFERENCES topics(topic_id) ON DELETE CASCADE,
                related_topic_id uuid NOT NULL REFERENCES topics(topic_id) ON DELETE CASCADE,
                shared_ideas     integer NOT NULL,
                jaccard          double precision NOT NULL,
                PRIMARY KEY (topic_id, related_topic_id)
            )
            """
        )
    )
    op.execute(
        text(
            "CREATE INDEX ix_topic_related_topic_id "
            "ON topic_related (topic_id, jaccard DESC)"
        )
    )

    # -- Backlinks (article-level reality from verify) ---------------------
    # Built by phase 5 verify from actual [title](wiki/<slug>.md) citations
    # in rendered prose. Separate from topic_links (topic-level intent).
    op.execute(
        text(
            """
            CREATE TABLE backlinks (
                source_document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
                target_document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
                PRIMARY KEY (source_document_id, target_document_id)
            )
            """
        )
    )
    op.execute(
        text(
            "CREATE INDEX ix_backlinks_source_document_id "
            "ON backlinks (source_document_id)"
        )
    )
    op.execute(
        text(
            "CREATE INDEX ix_backlinks_target_document_id "
            "ON backlinks (target_document_id)"
        )
    )

    # -- Absurd (durable task queue) schema --------------------------------
    url = op.get_bind().engine.url
    pg_url = f"postgresql://{url.username or ''}{':%s' % url.password if url.password else ''}@{url.host or 'localhost'}:{url.port or 5432}/{url.database}"
    sql = (Path(__file__).resolve().parent.parent / "absurd.sql").read_text()
    with psycopg.connect(pg_url, autocommit=True) as conn:
        conn.execute(sql.encode())
        conn.execute(b"SELECT absurd.create_queue('default')")


def downgrade() -> None:
    # Rolling back the initial schema would drop every table, the
    # vector extension, and the absurd queue schema — a destructive
    # operation better expressed as DROP DATABASE + CREATE DATABASE +
    # alembic upgrade head. Raising here keeps accidental downgrades
    # from silently destroying the schema.
    raise NotImplementedError(
        "initial schema is not reversible; drop and recreate the database instead"
    )
