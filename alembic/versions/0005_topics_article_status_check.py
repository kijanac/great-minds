"""topics.article_status — bound to the ArticleStatus value set via CHECK

article_status was a free Text column shadowing the ArticleStatus StrEnum, so
the type system couldn't tell a valid status from a typo and every SQL site had
to remember a manual ``.value``. The column is now mapped as
Enum(ArticleStatus, native_enum=False): SQLAlchemy coerces reads to the enum and
validates writes Python-side. This migration adds the matching DB-level CHECK so
a value outside the set is rejected at the database too, not just in Python.

Existing rows already hold exactly these strings (the column default was
'no_article' and every writer went through ArticleStatus.<member>.value), so the
constraint validates against current data with no rewrite.

Revision ID: 0005
Revises: 0004
Create Date: 2026-06-10
"""

from typing import Sequence, Union

from alembic import op

revision: str = "0005"
down_revision: Union[str, Sequence[str], None] = "0004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_CONSTRAINT = "ck_topics_article_status"


def upgrade() -> None:
    op.create_check_constraint(
        _CONSTRAINT,
        "topics",
        "article_status IN ('no_article', 'rendered', 'needs_revision', 'archived')",
    )


def downgrade() -> None:
    op.drop_constraint(_CONSTRAINT, "topics", type_="check")
