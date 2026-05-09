"""initial schema

Full schema for the seven-phase pipeline: users, auth, vaults,
memberships, proposals, tasks, compile_intents (outbox), search index,
documents, idea_embeddings, topics + topic_membership + topic_links +
topic_related, backlinks (keyed by document_id), and the absurd task queue.

Includes per-user/per-vault ``r2_bucket_name`` and ``source_proposals``
``dest_path`` + pending-dedup index + ``document_id`` FK (populated on approval).

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
        sa.Column("r2_bucket_name", sa.Text(), nullable=True),
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

    # -- Vaults & memberships ----------------------------------------------
    op.create_table(
        "vaults",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("owner_id", sa.UUID(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("r2_bucket_name", sa.Text(), nullable=True),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_table(
        "vault_memberships",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("vault_id", sa.UUID(), nullable=False),
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
        sa.ForeignKeyConstraint(["vault_id"], ["vaults.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("vault_id", "user_id"),
    )

    # -- Source proposals ---------------------------------------------------
    op.create_table(
        "source_proposals",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("vault_id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column(
            "status",
            sa.Enum("PENDING", "APPROVED", "REJECTED", name="proposal_status"),
            nullable=False,
        ),
        sa.Column("content_type", sa.String(length=50), nullable=False),
        sa.Column("title", sa.Text(), nullable=True),
        sa.Column("author", sa.Text(), nullable=True),
        sa.Column("dest_path", sa.Text(), nullable=False, server_default=""),
        sa.Column("document_id", sa.UUID(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["vault_id"], ["vaults.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_source_proposals_vault_id", "source_proposals", ["vault_id"], unique=False
    )
    op.create_index(
        "ix_source_proposals_document_id",
        "source_proposals",
        ["document_id"],
        unique=False,
    )
    # Partial unique index: re-promoting the same session exchange returns
    # the existing pending proposal instead of inserting a duplicate.
    op.create_index(
        "ix_source_proposals_pending_dest",
        "source_proposals",
        ["vault_id", "dest_path"],
        unique=True,
        postgresql_where=sa.text("status = 'PENDING'"),
    )

    # -- Pipeline runs -----------------------------------------------------
    op.create_table(
        "pipeline_runs",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("vault_id", sa.UUID(), nullable=False),
        sa.Column("trigger", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False, server_default="pending"),
        sa.Column("current_phase", sa.Text(), nullable=False, server_default=""),
        sa.Column("phase_status", sa.Text(), nullable=False, server_default=""),
        sa.Column(
            "progress_steps",
            JSONB(),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("ingest_task_id", sa.UUID(), nullable=True),
        sa.Column("compile_intent_id", sa.UUID(), nullable=True),
        sa.Column("compile_task_id", sa.UUID(), nullable=True),
        sa.Column("active_task_id", sa.UUID(), nullable=True),
        sa.Column("active_task_type", sa.Text(), nullable=True),
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
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["vault_id"], ["vaults.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_pipeline_runs_vault_id",
        "pipeline_runs",
        ["vault_id"],
        unique=False,
    )
    op.create_index(
        "ix_pipeline_runs_vault_created",
        "pipeline_runs",
        ["vault_id", "created_at"],
        unique=False,
    )

    # Pipeline progress notifications. The DB row is the durable source of
    # truth; LISTEN/NOTIFY is only a small "go re-read this run" wakeup for
    # SSE handlers. Keep payloads tiny and let listeners fetch current state.
    op.execute(
        """
        CREATE OR REPLACE FUNCTION notify_pipeline_run_changed()
        RETURNS trigger AS $$
        BEGIN
            PERFORM pg_notify(
                'pipeline_progress',
                json_build_object(
                    'pipeline_run_id', NEW.id,
                    'vault_id', NEW.vault_id
                )::text
            );
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        """
    )
    op.execute(
        """
        CREATE TRIGGER pipeline_runs_notify_insert
        AFTER INSERT ON pipeline_runs
        FOR EACH ROW
        EXECUTE FUNCTION notify_pipeline_run_changed();
        """
    )
    op.execute(
        """
        CREATE TRIGGER pipeline_runs_notify_update
        AFTER UPDATE ON pipeline_runs
        FOR EACH ROW
        WHEN (
            OLD.status IS DISTINCT FROM NEW.status
            OR OLD.current_phase IS DISTINCT FROM NEW.current_phase
            OR OLD.phase_status IS DISTINCT FROM NEW.phase_status
            OR OLD.progress_steps IS DISTINCT FROM NEW.progress_steps
            OR OLD.error IS DISTINCT FROM NEW.error
            OR OLD.completed_at IS DISTINCT FROM NEW.completed_at
        )
        EXECUTE FUNCTION notify_pipeline_run_changed();
        """
    )

    # -- Tasks -------------------------------------------------------------
    op.create_table(
        "tasks",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("vault_id", sa.UUID(), nullable=False),
        sa.Column("type", sa.Text(), nullable=False),
        sa.Column("params", JSONB(), nullable=False),
        sa.Column("pipeline_run_id", sa.UUID(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["pipeline_run_id"], ["pipeline_runs.id"], ondelete="SET NULL"
        ),
        sa.ForeignKeyConstraint(["vault_id"], ["vaults.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_tasks_vault_id", "tasks", ["vault_id"], unique=False)
    op.create_index(
        "ix_tasks_pipeline_run_id", "tasks", ["pipeline_run_id"], unique=False
    )

    # -- Compile cache -----------------------------------------------------
    op.create_table(
        "compile_cache_entries",
        sa.Column(
            "id",
            sa.UUID(),
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("vault_id", sa.UUID(), nullable=False),
        sa.Column("phase", sa.Text(), nullable=False),
        sa.Column("cache_key", sa.Text(), nullable=False),
        sa.Column("value", JSONB(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["vault_id"], ["vaults.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("vault_id", "phase", "cache_key"),
    )
    op.create_index(
        "ix_compile_cache_entries_vault_id",
        "compile_cache_entries",
        ["vault_id"],
        unique=False,
    )

    # -- Compile intents (outbox: domain-change → eventual compile) --------
    # Lifecycle: pending → dispatched → satisfied. The partial unique index
    # on (vault_id) WHERE dispatched_at IS NULL coalesces concurrent ingests
    # to one pending intent per vault, enforced at the DB level.
    op.create_table(
        "compile_intents",
        sa.Column(
            "id",
            sa.UUID(),
            nullable=False,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("vault_id", sa.UUID(), nullable=False),
        sa.Column("pipeline_run_id", sa.UUID(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("dispatched_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("dispatched_task_id", sa.UUID(), nullable=True),
        sa.Column("satisfied_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["pipeline_run_id"], ["pipeline_runs.id"], ondelete="SET NULL"
        ),
        sa.ForeignKeyConstraint(["vault_id"], ["vaults.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_compile_intents_one_pending",
        "compile_intents",
        ["vault_id"],
        unique=True,
        postgresql_where=sa.text("dispatched_at IS NULL"),
    )
    op.create_index(
        "ix_compile_intents_pipeline_run_id",
        "compile_intents",
        ["pipeline_run_id"],
        unique=False,
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
        postgresql_where=sa.text("dispatched_at IS NOT NULL AND satisfied_at IS NULL"),
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
        sa.Column("vault_id", sa.UUID(), nullable=True),
        sa.Column("event_type", sa.Text(), nullable=False),
        sa.Column("cost_usd", sa.Numeric(precision=12, scale=6), nullable=False),
        sa.Column("correlation_id", sa.Text(), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["vault_id"], ["vaults.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_llm_cost_events_user_created",
        "llm_cost_events",
        ["user_id", "created_at"],
    )
    op.create_index(
        "ix_llm_cost_events_vault_created",
        "llm_cost_events",
        ["vault_id", "created_at"],
    )

    # -- Search index (pgvector + tsvector) --------------------------------
    op.execute(
        text("""
        CREATE TABLE search_index (
            id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            vault_id    UUID NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
            path        TEXT NOT NULL,
            chunk_index INTEGER NOT NULL DEFAULT 0,
            heading     TEXT NOT NULL DEFAULT '',
            body        TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            tsv         tsvector NOT NULL,
            embedding   vector(1024),
            updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

            UNIQUE (vault_id, path, chunk_index)
        )
    """)
    )
    op.execute(text("CREATE INDEX ix_search_index_vault_id ON search_index (vault_id)"))
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
        sa.Column("vault_id", sa.UUID(), nullable=False),
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
        # source_type is the vault-config bucket (texts/news/ideas) for
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
        sa.ForeignKeyConstraint(["vault_id"], ["vaults.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("vault_id", "file_path"),
    )
    op.create_index("ix_documents_vault_id", "documents", ["vault_id"])
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

    # FK from source_proposals — deferred because documents table doesn't
    # exist yet at the point source_proposals is created above.
    op.create_foreign_key(
        "fk_source_proposals_document_id",
        "source_proposals",
        "documents",
        ["document_id"],
        ["id"],
        ondelete="SET NULL",
    )

    # -- Idea embeddings (per-Idea vectors, pgvector-backed) ---------------
    op.execute(
        text(
            """
            CREATE TABLE idea_embeddings (
                idea_id       uuid PRIMARY KEY,
                vault_id      uuid NOT NULL,
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
        text("CREATE INDEX ix_idea_embeddings_vault_id ON idea_embeddings (vault_id)")
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
                vault_id            uuid NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
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
                UNIQUE (vault_id, slug)
            )
            """
        )
    )
    op.execute(text("CREATE INDEX ix_topics_vault_id ON topics (vault_id)"))
    op.execute(text("CREATE INDEX ix_topics_article_status ON topics (article_status)"))

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
        text("CREATE INDEX ix_topic_membership_idea_id ON topic_membership (idea_id)")
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
        text("CREATE INDEX ix_topic_links_target ON topic_links (target_topic_id)")
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

    # -- Topic FK on documents (one wiki document per topic) ---------------
    # FK is added after topics exists. NULL for raw rows, set for wiki rows
    # by render. Partial unique index enforces 1 wiki document per topic.
    op.add_column(
        "documents",
        sa.Column(
            "topic_id",
            sa.UUID(),
            sa.ForeignKey("topics.topic_id", ondelete="CASCADE"),
            nullable=True,
        ),
    )
    op.create_index(
        "ix_documents_topic_id_wiki",
        "documents",
        ["topic_id"],
        unique=True,
        postgresql_where=sa.text("doc_kind = 'wiki'"),
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

    # -- Sessions listing index --------------------------------------------
    # JSONL files remain the authoritative event log; this table is a
    # minimal query index for list/filter/sort pagination.
    op.create_table(
        "sessions",
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("vault_id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("query", sa.Text(), nullable=False),
        sa.Column("origin", JSONB(), nullable=True),
        sa.Column("created", sa.Text(), nullable=False),
        sa.Column("updated", sa.Text(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["vault_id"], ["vaults.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id", "vault_id"),
    )
    op.create_index("ix_sessions_vault_id", "sessions", ["vault_id"])
    op.create_index("ix_sessions_user_id", "sessions", ["user_id"])
    op.create_index("ix_sessions_updated", "sessions", ["updated"])
    op.create_index(
        "ix_sessions_vault_user_updated",
        "sessions",
        ["vault_id", "user_id", "updated"],
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
