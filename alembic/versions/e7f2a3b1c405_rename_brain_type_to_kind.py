"""rename brain type to kind

Revision ID: e7f2a3b1c405
Revises: d4a1e7f3b902
Create Date: 2026-04-06 22:00:00.000000
"""

from alembic import op

revision = "e7f2a3b1c405"
down_revision = "d4a1e7f3b902"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column("brains", "type", new_column_name="kind")
    op.execute("ALTER TYPE brain_type RENAME TO brain_kind")


def downgrade() -> None:
    op.execute("ALTER TYPE brain_kind RENAME TO brain_type")
    op.alter_column("brains", "kind", new_column_name="type")
