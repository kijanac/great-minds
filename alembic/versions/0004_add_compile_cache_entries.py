"""Add DB-backed compile cache entries."""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
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
        sa.Column("value", postgresql.JSONB(), nullable=False),
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
        op.f("ix_compile_cache_entries_vault_id"),
        "compile_cache_entries",
        ["vault_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(
        op.f("ix_compile_cache_entries_vault_id"), table_name="compile_cache_entries"
    )
    op.drop_table("compile_cache_entries")
