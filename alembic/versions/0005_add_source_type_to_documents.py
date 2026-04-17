"""add source_type column to documents

Provenance tag for the ingress rail. Every document carries one of
`document | user | lint`; existing rows default to `document`. The
column propagates to SourceCard.source_type at Phase 1 and drives
citation filtering at Phase 3.

Revision ID: 0005
Revises: 0004
Create Date: 2026-04-16
"""

from typing import Sequence, Union

from alembic import op
from sqlalchemy import text


revision: str = "0005"
down_revision: Union[str, Sequence[str], None] = "0004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        text(
            "ALTER TABLE documents "
            "ADD COLUMN source_type text NOT NULL DEFAULT 'document'"
        )
    )


def downgrade() -> None:
    op.execute(text("ALTER TABLE documents DROP COLUMN source_type"))
