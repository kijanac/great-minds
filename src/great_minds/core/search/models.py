"""SearchIndexEntry — one row per indexable chunk.

Each row carries a tsvector (for BM25) and a pgvector embedding (for
cosine similarity). Chunk identity is (vault_id, path, chunk_index)
where chunk_index aligns with markdown.paragraphs() so it matches the
^pN anchors extract persists on Anchor.chunk_index.
"""

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
    __table_args__ = (UniqueConstraint("vault_id", "path", "chunk_index"),)

    id: Mapped[UUID] = mapped_column(
        PG_UUID, primary_key=True, server_default=func.gen_random_uuid()
    )
    vault_id: Mapped[UUID] = mapped_column(PG_UUID, index=True)
    path: Mapped[str] = mapped_column(Text)
    chunk_index: Mapped[int] = mapped_column(Integer, default=0)
    heading: Mapped[str] = mapped_column(Text, default="")
    body: Mapped[str] = mapped_column(Text)
    content_hash: Mapped[str] = mapped_column(Text)
    tsv: Mapped[str] = mapped_column(TSVECTOR)
    embedding: Mapped[list[float] | None] = mapped_column(Vector(EMBEDDING_DIMENSIONS))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
    )
