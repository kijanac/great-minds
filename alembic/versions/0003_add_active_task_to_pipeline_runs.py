"""Add active task pointer to pipeline runs."""

from alembic import op
import sqlalchemy as sa

revision = "0003_add_active_task_to_pipeline_runs"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "pipeline_runs", sa.Column("active_task_id", sa.UUID(), nullable=True)
    )
    op.add_column(
        "pipeline_runs", sa.Column("active_task_type", sa.Text(), nullable=True)
    )
    op.execute(
        """
        UPDATE pipeline_runs
        SET active_task_id = COALESCE(compile_task_id, ingest_task_id),
            active_task_type = CASE
                WHEN compile_task_id IS NOT NULL THEN 'compile'
                WHEN ingest_task_id IS NOT NULL THEN 'staged_file_ingest'
                ELSE NULL
            END
        WHERE active_task_id IS NULL
        """
    )


def downgrade() -> None:
    op.drop_column("pipeline_runs", "active_task_type")
    op.drop_column("pipeline_runs", "active_task_id")
