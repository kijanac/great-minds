"""drop server-side default from source_documents.title

Title is always supplied by the ingest path (parsed from frontmatter
or derived from filename/URL). The DEFAULT '' on the column silently
filled in an empty title for any insert that omitted it, which would
mask a bug. Strip the default so missing-title inserts fail loudly at
the DB layer. Column stays NOT NULL.

Revision ID: 0007
Revises: 0006
Create Date: 2026-05-12
"""

from typing import Sequence, Union

from alembic import op

revision: str = "0007"
down_revision: Union[str, Sequence[str], None] = "0006"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.alter_column("source_documents", "title", server_default=None)


def downgrade() -> None:
    op.alter_column("source_documents", "title", server_default="")
