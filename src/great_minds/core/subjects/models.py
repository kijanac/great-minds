"""ORM models for the subjects domain.

Currently holds only the idea_embeddings table — a persistent cache of
per-Idea embedding vectors. Written during canonicalization, queried for
ANN top-K neighbor lookup.

Idea itself is file-authoritative (SourceCard JSONL) per the files-first
storage invariant; this table mirrors embedding-only columns needed for
fast cosine-similarity queries.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from pgvector.sqlalchemy import Vector
from sqlalchemy import DateTime, Integer, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from great_minds.core.db import Base
from great_minds.core.llm import EMBEDDING_DIMENSIONS


class IdeaEmbeddingORM(Base):
    __tablename__ = "idea_embeddings"

    idea_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True
    )
    brain_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), nullable=False, index=True
    )
    document_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), nullable=False
    )
    label: Mapped[str] = mapped_column(Text, nullable=False)
    scope_note: Mapped[str] = mapped_column(Text, nullable=False)
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    embedding = mapped_column(Vector(EMBEDDING_DIMENSIONS), nullable=False)
    extraction_version: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
