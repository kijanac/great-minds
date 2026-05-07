"""drop redundant task progress columns

Revision ID: 0002
Revises: 0001
Create Date: 2026-05-06
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0002"
down_revision: Union[str, Sequence[str], None] = "0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_COLUMNS = (
    "progress_total",
    "progress_done",
    "progress_failed",
    "progress_failed_names",
)


def upgrade() -> None:
    for column in _COLUMNS:
        op.execute(sa.text(f"ALTER TABLE tasks DROP COLUMN IF EXISTS {column}"))


def downgrade() -> None:
    op.execute(
        sa.text(
            "ALTER TABLE tasks "
            "ADD COLUMN IF NOT EXISTS progress_total integer NOT NULL DEFAULT 0, "
            "ADD COLUMN IF NOT EXISTS progress_done integer NOT NULL DEFAULT 0, "
            "ADD COLUMN IF NOT EXISTS progress_failed integer NOT NULL DEFAULT 0, "
            "ADD COLUMN IF NOT EXISTS progress_failed_names jsonb NOT NULL DEFAULT '[]'::jsonb"
        )
    )
