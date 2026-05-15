"""rename idea_embeddings → ideas, add anchors table, cascade FKs

Source cards stop being a JSONL blob on R2 and become first-class PG
rows. The existing ``idea_embeddings`` table already carries everything
about an idea except the per-anchor records — the embedding is just one
column on what was always an ideas row. Rename clarifies that.

New ``anchors`` table holds the per-idea claim/quote/chunk_index records
with order-as-identity (composite PK ``(idea_id, position)``).

Cascade chain: source_documents → ideas → anchors. Removing a document
takes its ideas and their anchors with it in one declarative step.

Revision ID: 0011
Revises: 0010
Create Date: 2026-05-15
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0011"
down_revision: Union[str, Sequence[str], None] = "0010"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.rename_table("idea_embeddings", "ideas")

    # Drop any ideas whose document was deleted out from under them
    # (no FK enforced before this migration). Required before adding
    # the cascade FK.
    op.execute(
        "DELETE FROM ideas WHERE document_id NOT IN (SELECT id FROM source_documents)"
    )

    op.create_foreign_key(
        "ideas_document_id_fkey",
        "ideas",
        "source_documents",
        ["document_id"],
        ["id"],
        ondelete="CASCADE",
    )

    op.create_table(
        "anchors",
        sa.Column(
            "idea_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("ideas.idea_id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("position", sa.Integer(), primary_key=True),
        sa.Column("claim", sa.Text(), nullable=False),
        sa.Column("quote", sa.Text(), nullable=False),
        sa.Column("chunk_index", sa.Integer(), nullable=True),
    )


def downgrade() -> None:
    op.drop_table("anchors")
    op.drop_constraint("ideas_document_id_fkey", "ideas", type_="foreignkey")
    op.rename_table("ideas", "idea_embeddings")
