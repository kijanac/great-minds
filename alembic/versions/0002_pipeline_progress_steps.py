"""replace flat pipeline progress with structured steps

Revision ID: 0002
Revises: 0001
Create Date: 2026-05-09
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "0002"
down_revision: Union[str, Sequence[str], None] = "0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "pipeline_runs",
        sa.Column(
            "progress_steps",
            JSONB(),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
    )
    op.execute("DROP TRIGGER IF EXISTS pipeline_runs_notify_update ON pipeline_runs;")
    op.drop_column("pipeline_runs", "progress_message")
    op.drop_column("pipeline_runs", "progress_failed")
    op.drop_column("pipeline_runs", "progress_total")
    op.drop_column("pipeline_runs", "progress_done")

    op.execute(
        """
        CREATE TRIGGER pipeline_runs_notify_update
        AFTER UPDATE ON pipeline_runs
        FOR EACH ROW
        WHEN (
            OLD.status IS DISTINCT FROM NEW.status
            OR OLD.current_phase IS DISTINCT FROM NEW.current_phase
            OR OLD.phase_status IS DISTINCT FROM NEW.phase_status
            OR OLD.progress_steps IS DISTINCT FROM NEW.progress_steps
            OR OLD.error IS DISTINCT FROM NEW.error
            OR OLD.completed_at IS DISTINCT FROM NEW.completed_at
        )
        EXECUTE FUNCTION notify_pipeline_run_changed();
        """
    )


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS pipeline_runs_notify_update ON pipeline_runs;")
    op.add_column(
        "pipeline_runs",
        sa.Column("progress_done", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column(
        "pipeline_runs",
        sa.Column("progress_total", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column(
        "pipeline_runs",
        sa.Column("progress_failed", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column(
        "pipeline_runs",
        sa.Column("progress_message", sa.Text(), nullable=False, server_default=""),
    )
    op.drop_column("pipeline_runs", "progress_steps")

    op.execute(
        """
        CREATE TRIGGER pipeline_runs_notify_update
        AFTER UPDATE ON pipeline_runs
        FOR EACH ROW
        WHEN (
            OLD.status IS DISTINCT FROM NEW.status
            OR OLD.current_phase IS DISTINCT FROM NEW.current_phase
            OR OLD.phase_status IS DISTINCT FROM NEW.phase_status
            OR OLD.progress_done IS DISTINCT FROM NEW.progress_done
            OR OLD.progress_total IS DISTINCT FROM NEW.progress_total
            OR OLD.progress_failed IS DISTINCT FROM NEW.progress_failed
            OR OLD.progress_message IS DISTINCT FROM NEW.progress_message
            OR OLD.error IS DISTINCT FROM NEW.error
            OR OLD.completed_at IS DISTINCT FROM NEW.completed_at
        )
        EXECUTE FUNCTION notify_pipeline_run_changed();
        """
    )
