"""SearchIndexEntry — one row per indexable chunk.

Each row carries a tsvector (for BM25) and a pgvector embedding (for
cosine similarity). Chunk identity is (brain_id, path, chunk_index)
where chunk_index aligns with markdown.paragraphs() so it matches the
^pN anchors extract persists on Anchor.chunk_index.
"""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from pgvector.sqlalchemy import Vector
from sqlalchemy import DateTime, Integer, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import TSVECTOR, UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column

from great_minds.core.db import Base
from great_minds.core.llm import EMBEDDING_DIMENSIONS


class SearchIndexEntry(Base):
    __tablename__ = "search_index"
    __table_args__ = (UniqueConstraint("brain_id", "path", "chunk_index"),)

    id: Mapped[UUID] = mapped_column(
        PG_UUID, primary_key=True, server_default=func.gen_random_uuid()
    )
    brain_id: Mapped[UUID] = mapped_column(PG_UUID, nullable=False, index=True)
    path: Mapped[str] = mapped_column(Text, nullable=False)
    chunk_index: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    heading: Mapped[str] = mapped_column(Text, nullable=False, default="")
    body: Mapped[str] = mapped_column(Text, nullable=False)
    content_hash: Mapped[str] = mapped_column(Text, nullable=False)
    tsv: Mapped[str] = mapped_column(TSVECTOR, nullable=False)
    embedding = mapped_column(Vector(EMBEDDING_DIMENSIONS), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
