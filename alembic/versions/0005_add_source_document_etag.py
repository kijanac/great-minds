"""add etag column to source_documents

Store the R2 ETag (MD5 of single-part upload) so phase 0 ingest can
skip unchanged files without reading them from R2.

Revision ID: 0005
Revises: 0004
Create Date: 2026-05-11
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0005"
down_revision: Union[str, Sequence[str], None] = "0004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("source_documents", sa.Column("etag", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("source_documents", "etag")
