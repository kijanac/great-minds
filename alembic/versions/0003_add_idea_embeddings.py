"""add idea_embeddings table with HNSW index

Persistent store for per-Idea embedding vectors produced during
source-card extraction. Queried during canonicalization for ANN top-K
neighbor lookup via pgvector's cosine operator.

Revision ID: 0003
Revises: 0002
Create Date: 2026-04-14
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy import text


revision: str = "0003"
down_revision: Union[str, Sequence[str], None] = "0002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        text(
            """
            CREATE TABLE idea_embeddings (
                idea_id            uuid PRIMARY KEY,
                brain_id           uuid NOT NULL,
                document_id        uuid NOT NULL,
                label              text NOT NULL,
                scope_note         text NOT NULL,
                kind               text NOT NULL,
                embedding          vector(1024) NOT NULL,
                extraction_version integer NOT NULL,
                created_at         timestamptz NOT NULL DEFAULT now()
            )
            """
        )
    )
    op.execute(
        text("CREATE INDEX ix_idea_embeddings_brain_id ON idea_embeddings (brain_id)")
    )
    op.execute(
        text(
            "CREATE INDEX ix_idea_embeddings_embedding ON idea_embeddings "
            "USING hnsw (embedding vector_cosine_ops)"
        )
    )


def downgrade() -> None:
    op.execute(text("DROP TABLE IF EXISTS idea_embeddings"))
