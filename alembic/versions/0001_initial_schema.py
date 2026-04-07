"""initial schema

Squashed from 11 migrations into a single initial migration for fresh deploy.

Revision ID: 0001
Revises:
Create Date: 2026-04-07 00:00:00.000000
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
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
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
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
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
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
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
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_refresh_tokens_token_hash", "refresh_tokens", ["token_hash"], unique=True)

    # -- Brains & memberships ----------------------------------------------
    op.create_table(
        "brains",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("slug", sa.String(length=255), nullable=False),
        sa.Column("owner_id", sa.UUID(), nullable=False),
        sa.Column("kind", sa.Enum("PERSONAL", "TEAM", name="brain_kind"), nullable=False),
        sa.Column("storage_root", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_table(
        "brain_memberships",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("brain_id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("role", sa.Enum("OWNER", "EDITOR", "VIEWER", name="member_role"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
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
        sa.Column("status", sa.Enum("PENDING", "APPROVED", "REJECTED", name="proposal_status"), nullable=False),
        sa.Column("content_type", sa.String(length=50), nullable=False),
        sa.Column("title", sa.Text(), nullable=True),
        sa.Column("author", sa.Text(), nullable=True),
        sa.Column("storage_path", sa.Text(), nullable=False),
        sa.Column("reviewed_by", sa.UUID(), nullable=True),
        sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["brain_id"], ["brains.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["reviewed_by"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_source_proposals_brain_id", "source_proposals", ["brain_id"], unique=False)

    # -- Tasks -------------------------------------------------------------
    op.create_table(
        "tasks",
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("brain_id", sa.UUID(), nullable=False),
        sa.Column("type", sa.Text(), nullable=False),
        sa.Column("params", JSONB(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["brain_id"], ["brains.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_tasks_brain_id", "tasks", ["brain_id"], unique=False)

    # -- Search index (pgvector + tsvector) --------------------------------
    op.execute(text("""
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
    """))
    op.execute(text("CREATE INDEX ix_search_index_brain_id ON search_index (brain_id)"))
    op.execute(text("CREATE INDEX ix_search_index_tsv ON search_index USING GIN (tsv)"))
    op.execute(text("CREATE INDEX ix_search_index_embedding ON search_index USING hnsw (embedding vector_cosine_ops)"))

    # -- Absurd (durable task queue) schema --------------------------------
    url = op.get_bind().engine.url
    pg_url = f"postgresql://{url.username or ''}{':%s' % url.password if url.password else ''}@{url.host or 'localhost'}:{url.port or 5432}/{url.database}"
    sql = (Path(__file__).resolve().parent.parent / "absurd.sql").read_text()
    with psycopg.connect(pg_url, autocommit=True) as conn:
        conn.execute(sql.encode())
        conn.execute(b"SELECT absurd.create_queue('default')")


def downgrade() -> None:
    op.execute(text("DROP SCHEMA IF EXISTS absurd CASCADE"))
    op.execute(text("DROP TABLE IF EXISTS search_index"))
    op.drop_index("ix_tasks_brain_id", table_name="tasks")
    op.drop_table("tasks")
    op.drop_index("ix_source_proposals_brain_id", table_name="source_proposals")
    op.drop_table("source_proposals")
    op.drop_table("brain_memberships")
    op.drop_table("brains")
    op.drop_index("ix_refresh_tokens_token_hash", table_name="refresh_tokens")
    op.drop_table("refresh_tokens")
    op.drop_table("auth_codes")
    op.drop_index("ix_api_keys_key_hash", table_name="api_keys")
    op.drop_table("api_keys")
    op.drop_index("ix_users_email", table_name="users")
    op.drop_table("users")
    op.execute(text("DROP EXTENSION IF EXISTS vector"))
