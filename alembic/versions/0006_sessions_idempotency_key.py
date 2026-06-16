"""sessions.idempotency_key — server-minted session ids + retry dedup

Session ids are now minted server-side (uuid7). The client passes an
idempotency_key on create so a retried create (e.g. the response was lost
after the server committed) returns the existing session instead of writing
a duplicate. The unique constraint on (vault_id, idempotency_key) enforces
that. Postgres treats NULLs as distinct, so legacy rows (no key) coexist.

Revision ID: 0006
Revises: 0005
Create Date: 2026-06-16
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0006"
down_revision: Union[str, Sequence[str], None] = "0005"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("sessions", sa.Column("idempotency_key", sa.Text(), nullable=True))
    op.create_unique_constraint(
        "uq_sessions_vault_idempotency", "sessions", ["vault_id", "idempotency_key"]
    )


def downgrade() -> None:
    op.drop_constraint("uq_sessions_vault_idempotency", "sessions", type_="unique")
    op.drop_column("sessions", "idempotency_key")
