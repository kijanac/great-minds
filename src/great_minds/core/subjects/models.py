"""ORM models for the subjects domain.

idea_embeddings is a persistent cache of per-Idea embedding vectors;
written during distillation, queried for ANN top-K neighbor lookup.

concepts is the Postgres mirror of the concept registry. Authoritative
state lives in .compile/<brain_id>/subjects.jsonl; this table is a
rebuildable cache that powers slug-continuity UUID7 stability, dirty
flagging via compiled_from_hash, and agent SQL queries over wiki
metadata. See concept_repository.upsert for the slug-keyed upsert that
makes concept_ids stable across re-distillations.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from pgvector.sqlalchemy import Vector
from sqlalchemy import DateTime, Integer, Text, UniqueConstraint, func
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
    description: Mapped[str] = mapped_column(Text, nullable=False)
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    embedding = mapped_column(Vector(EMBEDDING_DIMENSIONS), nullable=False)
    extraction_version: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class ConceptORM(Base):
    __tablename__ = "concepts"
    __table_args__ = (UniqueConstraint("brain_id", "slug"),)

    concept_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True
    )
    brain_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), nullable=False, index=True
    )
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    canonical_label: Mapped[str] = mapped_column(Text, nullable=False)
    slug: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    article_status: Mapped[str] = mapped_column(
        Text, nullable=False, server_default="no_article"
    )
    compiled_from_hash: Mapped[str] = mapped_column(Text, nullable=False)
    rendered_from_hash: Mapped[str | None] = mapped_column(Text, nullable=True)
    supersedes: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True
    )
    superseded_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
