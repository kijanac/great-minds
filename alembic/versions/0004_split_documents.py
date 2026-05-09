"""Split documents table into source_documents and wiki_articles.

Revision ID: 0003
Create Date: 2026-05-09
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy import text

revision: str = "0004"
down_revision: str | None = "0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _assert_equal(conn, label: str, query: str) -> None:
    """Run a single-row, single-column query and raise if it's falsy."""
    val = conn.execute(text(query)).scalar()
    if not val:
        raise RuntimeError(f"Migration assertion failed: {label} (got {val!r})")


def upgrade() -> None:
    conn = op.get_bind()

    # ── 0. Idempotency — drop any partially-created state ────────────────
    conn.execute(text("DROP TABLE IF EXISTS backlinks CASCADE"))
    conn.execute(text("DROP TABLE IF EXISTS source_document_tags CASCADE"))
    conn.execute(text("DROP TABLE IF EXISTS source_documents CASCADE"))
    conn.execute(text("DROP TABLE IF EXISTS wiki_articles CASCADE"))

    # ── snapshot pre-migration counts ────────────────────────────────────
    raw_count = conn.execute(
        text("SELECT count(*) FROM documents WHERE doc_kind = 'raw'")
    ).scalar()
    wiki_count = conn.execute(
        text(
            "SELECT count(*) FROM documents WHERE doc_kind = 'wiki' AND topic_id IS NOT NULL"
        )
    ).scalar()
    tag_count = conn.execute(
        text("""
            SELECT count(*) FROM document_tags dt
            JOIN documents d ON d.id = dt.document_id
            WHERE d.doc_kind = 'raw'
        """)
    ).scalar()

    # ── 1. Create new tables ─────────────────────────────────────────────

    op.create_table(
        "source_documents",
        sa.Column(
            "id", sa.UUID(), primary_key=True, server_default=text("gen_random_uuid()")
        ),
        sa.Column(
            "vault_id",
            sa.UUID(),
            sa.ForeignKey("vaults.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("file_path", sa.Text(), nullable=False),
        sa.Column("file_hash", sa.Text(), nullable=False),
        sa.Column("body_hash", sa.Text(), nullable=False),
        sa.Column("title", sa.Text(), server_default=""),
        sa.Column("author", sa.Text(), nullable=True),
        sa.Column("url", sa.Text(), nullable=True),
        sa.Column("origin", sa.Text(), nullable=True),
        sa.Column("published_date", sa.Text(), nullable=True),
        sa.Column("genre", sa.Text(), nullable=True),
        sa.Column("compiled", sa.Boolean(), server_default="false"),
        sa.Column("source_type", sa.Text(), nullable=True),
        sa.Column("precis", sa.Text(), nullable=True),
        sa.Column("metadata", sa.dialects.postgresql.JSONB(), server_default="{}"),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=text("now()")
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=text("now()")
        ),
        sa.UniqueConstraint("vault_id", "file_path"),
    )
    op.execute(
        text(
            "CREATE INDEX IF NOT EXISTS ix_source_documents_vault_id ON source_documents (vault_id)"
        )
    )
    op.execute(
        text(
            "CREATE INDEX IF NOT EXISTS ix_source_documents_compiled ON source_documents (compiled)"
        )
    )
    op.execute(
        text(
            "CREATE INDEX IF NOT EXISTS ix_source_documents_metadata_gin "
            "ON source_documents USING GIN (metadata)"
        )
    )

    op.create_table(
        "source_document_tags",
        sa.Column(
            "document_id",
            sa.UUID(),
            sa.ForeignKey("source_documents.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("tag", sa.Text(), nullable=False),
        sa.PrimaryKeyConstraint("document_id", "tag"),
    )
    op.execute(
        text(
            "CREATE INDEX IF NOT EXISTS ix_source_document_tags_tag ON source_document_tags (tag)"
        )
    )

    op.create_table(
        "wiki_articles",
        sa.Column(
            "id", sa.UUID(), primary_key=True, server_default=text("gen_random_uuid()")
        ),
        sa.Column(
            "vault_id",
            sa.UUID(),
            sa.ForeignKey("vaults.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "topic_id",
            sa.UUID(),
            sa.ForeignKey("topics.topic_id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("file_path", sa.Text(), nullable=False),
        sa.Column("file_hash", sa.Text(), nullable=False),
        sa.Column("body_hash", sa.Text(), nullable=False),
        sa.Column("metadata", sa.dialects.postgresql.JSONB(), server_default="{}"),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=text("now()")
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=text("now()")
        ),
        sa.UniqueConstraint("vault_id", "file_path"),
        sa.UniqueConstraint("topic_id"),
    )
    op.execute(
        text(
            "CREATE INDEX IF NOT EXISTS ix_wiki_articles_vault_id ON wiki_articles (vault_id)"
        )
    )

    # ── 2. Backfill raw docs → source_documents ──────────────────────────

    op.execute(
        text("""
        INSERT INTO source_documents (
            id, vault_id, file_path, file_hash, body_hash,
            title, author, url, origin, published_date, genre,
            compiled, source_type, precis, metadata, created_at, updated_at
        )
        SELECT
            id, vault_id, file_path, file_hash, body_hash,
            title, author, url, origin, published_date, genre,
            compiled, source_type, precis, metadata, created_at, updated_at
        FROM documents
        WHERE doc_kind = 'raw'
    """)
    )
    _assert_equal(
        conn,
        "source_documents backfill row count",
        f"SELECT count(*) = {raw_count} FROM source_documents",
    )

    # ── 3. Backfill document_tags → source_document_tags ─────────────────

    op.execute(
        text("""
        INSERT INTO source_document_tags (document_id, tag)
        SELECT dt.document_id, dt.tag
        FROM document_tags dt
        JOIN documents d ON d.id = dt.document_id
        WHERE d.doc_kind = 'raw'
    """)
    )
    _assert_equal(
        conn,
        "source_document_tags backfill row count",
        f"SELECT count(*) = {tag_count} FROM source_document_tags",
    )

    # ── 4. Backfill wiki rows → wiki_articles ────────────────────────────

    op.execute(
        text("""
        INSERT INTO wiki_articles (
            id, vault_id, topic_id, file_path, file_hash, body_hash,
            metadata, created_at, updated_at
        )
        SELECT
            id, vault_id, topic_id, file_path, file_hash, body_hash,
            metadata, created_at, updated_at
        FROM documents
        WHERE doc_kind = 'wiki' AND topic_id IS NOT NULL
    """)
    )
    _assert_equal(
        conn,
        "wiki_articles backfill row count",
        f"SELECT count(*) = {wiki_count} FROM wiki_articles",
    )

    # ── 5. Repoint source_proposals FK ───────────────────────────────────

    op.drop_constraint(
        "fk_source_proposals_document_id", "source_proposals", type_="foreignkey"
    )
    op.create_foreign_key(
        "fk_source_proposals_document_id",
        "source_proposals",
        "source_documents",
        ["document_id"],
        ["id"],
        ondelete="SET NULL",
    )

    # ── 6. Drop old tables ───────────────────────────────────────────────

    op.drop_table("backlinks")
    op.drop_table("document_tags")
    op.drop_table("documents")

    # ── 7. Recreate backlinks with new FKs to wiki_articles ──────────────

    op.execute(
        text("""
        CREATE TABLE backlinks (
            source_article_id uuid NOT NULL
                REFERENCES wiki_articles(id) ON DELETE CASCADE,
            target_article_id uuid NOT NULL
                REFERENCES wiki_articles(id) ON DELETE CASCADE,
            PRIMARY KEY (source_article_id, target_article_id)
        )
    """)
    )
    op.execute(
        text(
            "CREATE INDEX IF NOT EXISTS ix_backlinks_source_article_id "
            "ON backlinks (source_article_id)"
        )
    )
    op.execute(
        text(
            "CREATE INDEX IF NOT EXISTS ix_backlinks_target_article_id "
            "ON backlinks (target_article_id)"
        )
    )


def downgrade() -> None:
    # ── Recreate old documents table ─────────────────────────────────────

    op.execute(
        text("""
        CREATE TABLE documents (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            vault_id uuid NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
            file_path text NOT NULL,
            file_hash text NOT NULL,
            body_hash text NOT NULL,
            title text NOT NULL DEFAULT '',
            author text,
            url text,
            origin text,
            published_date text,
            genre text,
            compiled boolean NOT NULL DEFAULT false,
            doc_kind text NOT NULL DEFAULT 'raw',
            source_type text,
            topic_id uuid REFERENCES topics(topic_id) ON DELETE CASCADE,
            precis text,
            metadata jsonb NOT NULL DEFAULT '{}',
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now(),
            UNIQUE (vault_id, file_path)
        )
    """)
    )
    op.execute(
        text(
            "CREATE UNIQUE INDEX ix_documents_topic_id_wiki "
            "ON documents (topic_id) WHERE doc_kind = 'wiki'"
        )
    )

    # Backfill documents from new tables
    op.execute(
        text("""
        INSERT INTO documents (
            id, vault_id, file_path, file_hash, body_hash,
            title, author, url, origin, published_date, genre,
            compiled, doc_kind, source_type, topic_id, precis, metadata
        )
        SELECT
            id, vault_id, file_path, file_hash, body_hash,
            title, author, url, origin, published_date, genre,
            compiled, 'raw', source_type, NULL, precis, metadata
        FROM source_documents
    """)
    )
    op.execute(
        text("""
        INSERT INTO documents (
            id, vault_id, file_path, file_hash, body_hash,
            title, author, url, origin, published_date, genre,
            compiled, doc_kind, source_type, topic_id, precis, metadata
        )
        SELECT
            id, vault_id, file_path, file_hash, body_hash,
            '', NULL, NULL, NULL, NULL, NULL,
            TRUE, 'wiki', NULL, topic_id, NULL, metadata
        FROM wiki_articles
    """)
    )

    # Recreate document_tags from source_document_tags
    op.execute(
        text("""
        CREATE TABLE document_tags (
            document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
            tag text NOT NULL,
            PRIMARY KEY (document_id, tag)
        )
    """)
    )
    op.execute(
        text("""
        INSERT INTO document_tags (document_id, tag)
        SELECT document_id, tag FROM source_document_tags
    """)
    )
    op.create_index("ix_document_tags_tag", "document_tags", ["tag"])

    # Repoint FK back
    op.drop_constraint(
        "fk_source_proposals_document_id", "source_proposals", type_="foreignkey"
    )
    op.create_foreign_key(
        "fk_source_proposals_document_id",
        "source_proposals",
        "documents",
        ["document_id"],
        ["id"],
        ondelete="SET NULL",
    )

    # Drop new tables
    op.drop_table("backlinks")
    op.drop_table("source_document_tags")
    op.drop_table("wiki_articles")
    op.drop_table("source_documents")

    # Recreate backlinks
    op.execute(
        text("""
        CREATE TABLE backlinks (
            source_document_id uuid NOT NULL
                REFERENCES documents(id) ON DELETE CASCADE,
            target_document_id uuid NOT NULL
                REFERENCES documents(id) ON DELETE CASCADE,
            PRIMARY KEY (source_document_id, target_document_id)
        )
    """)
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

    # Recreate indices on documents
    op.create_index("ix_documents_vault_id", "documents", ["vault_id"])
    op.create_index("ix_documents_published_date", "documents", ["published_date"])
    op.create_index("ix_documents_author", "documents", ["author"])
    op.create_index("ix_documents_compiled", "documents", ["compiled"])
    op.create_index("ix_documents_doc_kind", "documents", ["doc_kind"])
    op.execute(
        text("CREATE INDEX ix_documents_metadata_gin ON documents USING GIN (metadata)")
    )
