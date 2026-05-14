"""restore server_default on source_documents.tags

Migration 0008 added ``tags`` as ``NOT NULL DEFAULT ARRAY[]::text[]``,
backfilled from the legacy junction table, then promptly stripped the
server_default. That worked while ingest still wrote ``tags`` explicitly,
but the metadata refactor (0009) moved tags into the LLM-derived zone:
ingest no longer writes the column, extract fills it on first compile.

With no server_default on a NOT NULL column, every staged-file insert
that omits ``tags`` now fails with a NotNullViolationError. Restore the
default so omitted columns fall through to an empty array, matching the
ORM's declared ``server_default=ARRAY[]::text[]``.

Revision ID: 0010
Revises: 0009
Create Date: 2026-05-14
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0010"
down_revision: Union[str, Sequence[str], None] = "0009"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.alter_column(
        "source_documents",
        "tags",
        server_default=sa.text("ARRAY[]::text[]"),
    )


def downgrade() -> None:
    op.alter_column("source_documents", "tags", server_default=None)
