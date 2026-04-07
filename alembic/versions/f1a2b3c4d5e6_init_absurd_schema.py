"""init absurd schema

Revision ID: f1a2b3c4d5e6
Revises: d4a1e7f3b902
Create Date: 2026-04-06 21:00:00.000000

"""
from pathlib import Path
from typing import Sequence, Union

import psycopg
from alembic import op
from sqlalchemy import text


revision: str = 'f1a2b3c4d5e6'
down_revision: Union[str, Sequence[str], None] = ('bbd7c8738bc0', 'e7f2a3b1c405')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    sql = (Path(__file__).resolve().parent.parent / "absurd.sql").read_text()

    # asyncpg can't execute multi-statement SQL; use psycopg directly
    url = op.get_bind().engine.url
    pg_url = f"postgresql://{url.username or ''}{':%s' % url.password if url.password else ''}@{url.host or 'localhost'}:{url.port or 5432}/{url.database}"
    with psycopg.connect(pg_url, autocommit=True) as conn:
        conn.execute(sql.encode())
        conn.execute(b"SELECT absurd.create_queue('default')")


def downgrade() -> None:
    op.execute(text("DROP SCHEMA IF EXISTS absurd CASCADE"))
