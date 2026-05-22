"""wiki_articles.archived — flag articles whose topic was archived

When a recompile produces a different topic registry, validate archives the
superseded topics: it moves each article's file under archive/<topic_id>/ and
repoints the wiki_articles row there, but the row lives on so backlinks and
supersession reads still resolve. Without a typed flag, the wiki list and the
orphan lint couldn't tell live articles from archived ones (they keyed off
file_path), so archived articles leaked into both surfaces.

Backfill marks any row already living under archive/ as archived.

Revision ID: 0003
Revises: 0002
Create Date: 2026-05-22
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0003"
down_revision: Union[str, Sequence[str], None] = "0002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "wiki_articles",
        sa.Column(
            "archived",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )
    op.execute(
        "UPDATE wiki_articles SET archived = true WHERE file_path LIKE 'archive/%'"
    )


def downgrade() -> None:
    op.drop_column("wiki_articles", "archived")
