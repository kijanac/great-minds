"""wiki_articles.render_run_id — per-run provenance for the compile reward

Stamps each rendered (or re-materialized) wiki article with the pipeline
run that produced it, so the compile completion card can answer "what did
THIS compile build?" via a direct provenance link rather than a timestamp
heuristic.

ON DELETE SET NULL, never CASCADE: purging a run row must not delete the
articles it produced — provenance is lost, the wiki survives. Partial index
(WHERE render_run_id IS NOT NULL) keeps it lean; only the per-run delta
query reads the column.

Revision ID: 0002
Revises: 0001
Create Date: 2026-05-20
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0002"
down_revision: Union[str, Sequence[str], None] = "0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "wiki_articles",
        sa.Column("render_run_id", sa.UUID(), nullable=True),
    )
    op.create_foreign_key(
        "fk_wiki_articles_render_run_id_pipeline_runs",
        "wiki_articles",
        "pipeline_runs",
        ["render_run_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        "ix_wiki_articles_render_run_id",
        "wiki_articles",
        ["render_run_id"],
        postgresql_where=sa.text("render_run_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("ix_wiki_articles_render_run_id", table_name="wiki_articles")
    op.drop_constraint(
        "fk_wiki_articles_render_run_id_pipeline_runs",
        "wiki_articles",
        type_="foreignkey",
    )
    op.drop_column("wiki_articles", "render_run_id")
