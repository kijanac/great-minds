"""documents table, junction tables, and backlinks

Adds the queryable projection of frontmatter metadata plus
a backlinks index for bidirectional wiki graph traversal.

Revision ID: 0002
Revises: 0001
Create Date: 2026-04-08
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB


revision: str = "0002"
down_revision: Union[str, Sequence[str], None] = "0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
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
        sa.Column("title", sa.Text(), nullable=False, server_default=""),
        sa.Column("author", sa.Text(), nullable=True),
        sa.Column("source_type", sa.Text(), nullable=True),
        sa.Column("source_url", sa.Text(), nullable=True),
        sa.Column("published_date", sa.Text(), nullable=True),
        sa.Column("genre", sa.Text(), nullable=True),
        sa.Column("tradition", sa.Text(), nullable=True),
        sa.Column("compiled", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("doc_kind", sa.Text(), nullable=False, server_default="raw"),
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
    op.create_index("ix_documents_source_type", "documents", ["source_type"])
    op.create_index("ix_documents_published_date", "documents", ["published_date"])
    op.create_index("ix_documents_author", "documents", ["author"])
    op.create_index("ix_documents_compiled", "documents", ["compiled"])
    op.create_index("ix_documents_doc_kind", "documents", ["doc_kind"])

    # -- Junction: document_tags -------------------------------------------
    op.create_table(
        "document_tags",
        sa.Column("document_id", sa.UUID(), nullable=False),
        sa.Column("tag", sa.Text(), nullable=False),
        sa.ForeignKeyConstraint(
            ["document_id"], ["documents.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("document_id", "tag"),
    )
    op.create_index("ix_document_tags_tag", "document_tags", ["tag"])

    # -- Junction: document_concepts ---------------------------------------
    op.create_table(
        "document_concepts",
        sa.Column("document_id", sa.UUID(), nullable=False),
        sa.Column("concept", sa.Text(), nullable=False),
        sa.ForeignKeyConstraint(
            ["document_id"], ["documents.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("document_id", "concept"),
    )
    op.create_index("ix_document_concepts_concept", "document_concepts", ["concept"])

    # -- Junction: document_interlocutors ----------------------------------
    op.create_table(
        "document_interlocutors",
        sa.Column("document_id", sa.UUID(), nullable=False),
        sa.Column("interlocutor", sa.Text(), nullable=False),
        sa.ForeignKeyConstraint(
            ["document_id"], ["documents.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("document_id", "interlocutor"),
    )
    op.create_index(
        "ix_document_interlocutors_interlocutor",
        "document_interlocutors",
        ["interlocutor"],
    )

    # -- Backlinks ---------------------------------------------------------
    op.create_table(
        "backlinks",
        sa.Column(
            "id",
            sa.UUID(),
            nullable=False,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("brain_id", sa.UUID(), nullable=False),
        sa.Column("source_slug", sa.Text(), nullable=False),
        sa.Column("target_slug", sa.Text(), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["brain_id"], ["brains.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("brain_id", "source_slug", "target_slug"),
    )
    op.create_index("ix_backlinks_brain_id", "backlinks", ["brain_id"])
    op.create_index("ix_backlinks_target", "backlinks", ["brain_id", "target_slug"])


def downgrade() -> None:
    op.drop_index("ix_backlinks_target", table_name="backlinks")
    op.drop_index("ix_backlinks_brain_id", table_name="backlinks")
    op.drop_table("backlinks")
    op.drop_index(
        "ix_document_interlocutors_interlocutor",
        table_name="document_interlocutors",
    )
    op.drop_table("document_interlocutors")
    op.drop_index("ix_document_concepts_concept", table_name="document_concepts")
    op.drop_table("document_concepts")
    op.drop_index("ix_document_tags_tag", table_name="document_tags")
    op.drop_table("document_tags")
    op.drop_index("ix_documents_doc_kind", table_name="documents")
    op.drop_index("ix_documents_compiled", table_name="documents")
    op.drop_index("ix_documents_author", table_name="documents")
    op.drop_index("ix_documents_published_date", table_name="documents")
    op.drop_index("ix_documents_source_type", table_name="documents")
    op.drop_index("ix_documents_brain_id", table_name="documents")
    op.drop_table("documents")
