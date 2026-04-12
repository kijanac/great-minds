"""fix doc_kind for legacy raw documents

Earlier ingestion code wrote `doc_kind=content_type` (e.g. "texts", "news")
instead of the canonical `doc_kind="raw"`. Compilation was unaffected because
the compiler walks storage by path, but structured queries filtering by
`doc_kind="raw"` saw zero results.

Revision ID: 0002
Revises: 0001
Create Date: 2026-04-12
"""

from typing import Sequence, Union

from alembic import op
from sqlalchemy import text


revision: str = "0002"
down_revision: Union[str, Sequence[str], None] = "0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        text(
            "UPDATE documents "
            "SET doc_kind = 'raw' "
            "WHERE doc_kind NOT IN ('raw', 'wiki')"
        )
    )


def downgrade() -> None:
    # Irreversible: the original doc_kind values were meaningless; we cannot
    # reconstruct them. Leaving as a no-op is the only honest option.
    pass
