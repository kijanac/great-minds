"""freeze title/precis on wiki_articles at render time

Adds title and precis columns to wiki_articles. Render writes them
alongside the file body so reads no longer JOIN topics for display.
topics keeps the canonical live values; wiki_articles holds the
snapshot at the time of last render. Drift between the two is a
queryable staleness signal.

Also drops the legacy ``metadata`` JSONB column from wiki_articles.
It was never written by application code post-split and carried no
information; dropping it removes the dead surface.

Revision ID: 0006
Revises: 0005
Create Date: 2026-05-12
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "0006"
down_revision: Union[str, Sequence[str], None] = "0005"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "wiki_articles",
        sa.Column("title", sa.Text(), nullable=False, server_default=""),
    )
    op.add_column(
        "wiki_articles",
        sa.Column("precis", sa.Text(), nullable=False, server_default=""),
    )
    op.execute(
        """
        UPDATE wiki_articles
        SET title = topics.title,
            precis = topics.description
        FROM topics
        WHERE wiki_articles.topic_id = topics.topic_id
        """
    )
    op.alter_column("wiki_articles", "title", server_default=None)
    op.alter_column("wiki_articles", "precis", server_default=None)
    op.drop_column("wiki_articles", "metadata")


def downgrade() -> None:
    op.add_column(
        "wiki_articles",
        sa.Column("metadata", JSONB, nullable=False, server_default="{}"),
    )
    op.drop_column("wiki_articles", "precis")
    op.drop_column("wiki_articles", "title")
