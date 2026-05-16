"""add client_hash column to source_documents for upload dedup

The frontend computes ``sha256(file.arrayBuffer())`` per uploaded file
(the *raw bytes* hash) for the pre-flight dedup check. This is distinct
from ``file_hash`` (server-side hash of post-conversion content) and
``body_hash`` (post-frontmatter body hash). Storing the client-side
hash lets the UI ask "is this exact file already in the vault?" via a
single round-trip before showing the file-picker preview.

Nullable: existing rows have no client_hash; new uploads populate it.
Partial index keeps the index lean — most lookups are "give me the
ones that match," not "give me the NULLs."

Revision ID: 0012
Revises: 0011
Create Date: 2026-05-16
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0012"
down_revision: Union[str, Sequence[str], None] = "0011"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "source_documents",
        sa.Column("client_hash", sa.Text(), nullable=True),
    )
    op.create_index(
        "ix_source_documents_vault_client_hash",
        "source_documents",
        ["vault_id", "client_hash"],
        postgresql_where=sa.text("client_hash IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index(
        "ix_source_documents_vault_client_hash", table_name="source_documents"
    )
    op.drop_column("source_documents", "client_hash")
