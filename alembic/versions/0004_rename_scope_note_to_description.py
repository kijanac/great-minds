"""rename idea_embeddings.scope_note to description

Aligns the embeddings table with the renamed field on the Idea pydantic
schema. Embedding input is now f"{label}. {description}" at the
canonicalizer.

Revision ID: 0004
Revises: 0003
Create Date: 2026-04-16
"""

from typing import Sequence, Union

from alembic import op
from sqlalchemy import text


revision: str = "0004"
down_revision: Union[str, Sequence[str], None] = "0003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        text("ALTER TABLE idea_embeddings RENAME COLUMN scope_note TO description")
    )


def downgrade() -> None:
    op.execute(
        text("ALTER TABLE idea_embeddings RENAME COLUMN description TO scope_note")
    )
