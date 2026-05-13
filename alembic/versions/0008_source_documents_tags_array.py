"""move source-document tags from junction table to text[] column

Tags have no per-tag data — `source_document_tags` was a pure
(document_id, tag) junction with nothing else attached. That made the
common queries (multi-tag AND filter, eager fetch with the doc) require
a JOIN or a second round-trip, and forced a delete-then-insert sync on
every upsert.

Switch to a native `text[]` array column on `source_documents` with a
GIN index. Containment queries (`tags @> ARRAY['X','Y']`) hit the GIN
index directly; the per-row column means no JOIN to read tags
alongside the doc; upserts include tags in the same row write. Picked
`text[]` over `jsonb` so the element type is enforced by the DB and
nobody can smuggle a struct in later as a shortcut.

If tags ever grow attributes (color, description, vault-level config),
the right move at that point is a real ``tags`` entity table with FK
references — not bringing back this junction or widening the element
type.

Revision ID: 0008
Revises: 0007
Create Date: 2026-05-12
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0008"
down_revision: Union[str, Sequence[str], None] = "0007"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "source_documents",
        sa.Column(
            "tags",
            sa.ARRAY(sa.Text()),
            nullable=False,
            server_default=sa.text("ARRAY[]::text[]"),
        ),
    )
    op.execute(
        """
        UPDATE source_documents
        SET tags = t.tags
        FROM (
            SELECT document_id, array_agg(tag ORDER BY tag) AS tags
            FROM source_document_tags
            GROUP BY document_id
        ) t
        WHERE source_documents.id = t.document_id
        """
    )
    op.alter_column("source_documents", "tags", server_default=None)
    op.create_index(
        "ix_source_documents_tags",
        "source_documents",
        ["tags"],
        postgresql_using="gin",
    )
    op.drop_table("source_document_tags")


def downgrade() -> None:
    op.create_table(
        "source_document_tags",
        sa.Column(
            "document_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("source_documents.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("tag", sa.Text(), primary_key=True, index=True),
    )
    op.execute(
        """
        INSERT INTO source_document_tags (document_id, tag)
        SELECT id, unnest(tags)
        FROM source_documents
        WHERE array_length(tags, 1) > 0
        """
    )
    op.drop_index("ix_source_documents_tags", table_name="source_documents")
    op.drop_column("source_documents", "tags")
