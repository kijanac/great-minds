"""wiki_articles.tags — persist the LLM-generated article tags

Render's LLM emits 3-6 tags per article and the prompt requests them, but
they were never written anywhere — no column, no consumer. This adds the
mirror column so the tags land on the row alongside title/precis (snapshots
from the same render), queryable without parsing frontmatter. The render
write path now also emits ``tags`` into the article's frontmatter, so the
on-disk artifact and the row agree.

Existing rows default to an empty array; the next recompile backfills them.

Revision ID: 0004
Revises: 0003
Create Date: 2026-06-10
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0004"
down_revision: Union[str, Sequence[str], None] = "0003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "wiki_articles",
        sa.Column(
            "tags",
            postgresql.ARRAY(sa.Text()),
            nullable=False,
            server_default=sa.text("ARRAY[]::text[]"),
        ),
    )


def downgrade() -> None:
    op.drop_column("wiki_articles", "tags")
