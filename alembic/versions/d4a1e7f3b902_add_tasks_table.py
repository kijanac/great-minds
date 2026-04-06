"""add tasks table

Revision ID: d4a1e7f3b902
Revises: 0016831828fa
Create Date: 2026-04-06 20:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB


revision: str = 'd4a1e7f3b902'
down_revision: Union[str, Sequence[str], None] = '0016831828fa'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table('tasks',
        sa.Column('id', sa.Text(), nullable=False),
        sa.Column('brain_id', sa.UUID(), nullable=False),
        sa.Column('type', sa.Text(), nullable=False),
        sa.Column('params', JSONB(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['brain_id'], ['brains.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_tasks_brain_id'), 'tasks', ['brain_id'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_tasks_brain_id'), table_name='tasks')
    op.drop_table('tasks')
