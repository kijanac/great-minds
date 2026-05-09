"""Rename session timestamp columns and convert from Text to timestamptz.

Revision ID: 0003
Revises: 0002
Create Date: 2026-05-09
"""

from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0003"
down_revision: Union[str, Sequence[str], None] = "0002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Rename columns
    op.alter_column("sessions", "created", new_column_name="created_at")
    op.alter_column("sessions", "updated", new_column_name="updated_at")

    # Change type from text to timestamptz via USING. ISO 8601 strings
    # parse directly to timestamptz.
    op.execute(
        "ALTER TABLE sessions "
        "ALTER COLUMN created_at TYPE timestamptz USING created_at::timestamptz"
    )
    op.execute(
        "ALTER TABLE sessions "
        "ALTER COLUMN updated_at TYPE timestamptz USING updated_at::timestamptz"
    )

    # Rename indexes
    op.execute(
        "ALTER INDEX IF EXISTS ix_sessions_updated RENAME TO ix_sessions_updated_at"
    )
    op.execute(
        "ALTER INDEX IF EXISTS ix_sessions_vault_user_updated "
        "RENAME TO ix_sessions_vault_user_updated_at"
    )


def downgrade() -> None:
    # Convert back to text
    op.execute(
        "ALTER TABLE sessions ALTER COLUMN updated_at TYPE text USING updated_at::text"
    )
    op.execute(
        "ALTER TABLE sessions ALTER COLUMN created_at TYPE text USING created_at::text"
    )

    # Rename indexes back
    op.execute(
        "ALTER INDEX IF EXISTS ix_sessions_updated_at RENAME TO ix_sessions_updated"
    )
    op.execute(
        "ALTER INDEX IF EXISTS ix_sessions_vault_user_updated_at "
        "RENAME TO ix_sessions_vault_user_updated"
    )

    # Rename columns back
    op.alter_column("sessions", "updated_at", new_column_name="updated")
    op.alter_column("sessions", "created_at", new_column_name="created")
