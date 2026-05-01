"""proposal dest_path + pending dedup index

Add ``dest_path`` to source_proposals and a partial unique index on
``(brain_id, dest_path)`` for ``status = 'pending'`` so that re-promoting
the same session exchange returns the existing pending proposal instead
of creating a duplicate.

Revision ID: 0002
Revises: 0001
Create Date: 2026-04-30
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0002"
down_revision: Union[str, Sequence[str], None] = "0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "source_proposals",
        sa.Column(
            "dest_path",
            sa.Text(),
            nullable=False,
            server_default="",
        ),
    )
    op.create_index(
        "ix_source_proposals_pending_dest",
        "source_proposals",
        ["brain_id", "dest_path"],
        unique=True,
        postgresql_where=sa.text("status = 'PENDING'"),
    )


def downgrade() -> None:
    op.drop_index(
        "ix_source_proposals_pending_dest", table_name="source_proposals"
    )
    op.drop_column("source_proposals", "dest_path")
