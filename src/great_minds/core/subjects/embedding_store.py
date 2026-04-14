"""pgvector-backed store for Idea embeddings.

Persists per-Idea embedding vectors and exposes ANN top-K neighbor
queries for canonicalization clustering. Enables:
- Memory-bounded clustering at scale (no full N x N similarity matrix)
- Embedding caching across re-runs (incremental compilation)
"""

import uuid

import numpy as np
import sqlalchemy as sa
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from great_minds.core.db import session_maker
from great_minds.core.subjects.models import IdeaEmbeddingORM
from great_minds.core.subjects.schemas import Idea
from great_minds.core.telemetry import log_event

DEFAULT_TOP_K = 30
UPSERT_BATCH_SIZE = 500


async def upsert_idea_embeddings(
    session: AsyncSession,
    *,
    brain_id: uuid.UUID,
    ideas_flat: list[tuple[uuid.UUID, Idea]],
    vectors: np.ndarray,
    extraction_version: int,
) -> None:
    """Insert or update idea_embeddings rows for all Ideas in a canonicalization batch.

    Uses ON CONFLICT DO UPDATE on idea_id. Safe to re-run — updates
    embeddings/metadata for existing Ideas.
    """
    if len(ideas_flat) != len(vectors):
        raise ValueError(
            f"ideas_flat ({len(ideas_flat)}) and vectors ({len(vectors)}) length mismatch"
        )

    rows = [
        {
            "idea_id": idea.idea_id,
            "brain_id": brain_id,
            "document_id": doc_id,
            "label": idea.label,
            "scope_note": idea.scope_note,
            "kind": idea.kind.value,
            "embedding": vec.tolist(),
            "extraction_version": extraction_version,
        }
        for (doc_id, idea), vec in zip(ideas_flat, vectors)
    ]

    for start in range(0, len(rows), UPSERT_BATCH_SIZE):
        batch = rows[start : start + UPSERT_BATCH_SIZE]
        stmt = insert(IdeaEmbeddingORM).values(batch)
        stmt = stmt.on_conflict_do_update(
            index_elements=["idea_id"],
            set_={
                "brain_id": stmt.excluded.brain_id,
                "document_id": stmt.excluded.document_id,
                "label": stmt.excluded.label,
                "scope_note": stmt.excluded.scope_note,
                "kind": stmt.excluded.kind,
                "embedding": stmt.excluded.embedding,
                "extraction_version": stmt.excluded.extraction_version,
            },
        )
        await session.execute(stmt)

    await session.commit()
    log_event(
        "idea_embeddings_upserted",
        brain_id=str(brain_id),
        count=len(rows),
    )


async def query_neighbor_edges(
    *,
    brain_id: uuid.UUID,
    ideas_flat: list[tuple[uuid.UUID, Idea]],
    k: int,
    threshold: float,
) -> list[tuple[int, int]]:
    """Single pg query returning all top-K neighbor edges above threshold.

    pgvector's HNSW index is used per outer row via LATERAL; similarity
    threshold and brain scope are applied in SQL. Edges are deduplicated
    (canonical direction i < j) and filtered to Ideas present in
    ideas_flat (excludes any stale pg rows from prior batches that
    aren't in this canonicalization call).
    """
    a = aliased(IdeaEmbeddingORM, name="a")
    b = aliased(IdeaEmbeddingORM, name="b")
    dist = b.embedding.cosine_distance(a.embedding)

    neighbors = (
        select(b.idea_id.label("idea_id"), b.embedding.label("embedding"))
        .where(b.brain_id == a.brain_id)
        .where(b.idea_id != a.idea_id)
        .order_by(dist)
        .limit(k)
        .lateral("nn")
    )
    outer_dist = neighbors.c.embedding.cosine_distance(a.embedding)
    similarity = (1 - outer_dist).label("similarity")
    stmt = (
        select(
            a.idea_id.label("src"),
            neighbors.c.idea_id.label("dst"),
            similarity,
        )
        .select_from(a)
        .join(neighbors, sa.true())
        .where(a.brain_id == brain_id)
        .where((1 - outer_dist) >= threshold)
    )

    idea_id_to_index = {idea.idea_id: i for i, (_, idea) in enumerate(ideas_flat)}
    async with session_maker() as session:
        result = await session.execute(stmt)
        rows = result.fetchall()

    edges: set[tuple[int, int]] = set()
    for row in rows:
        i = idea_id_to_index.get(row.src)
        j = idea_id_to_index.get(row.dst)
        if i is None or j is None:
            continue
        lo, hi = (i, j) if i < j else (j, i)
        edges.add((lo, hi))
    return sorted(edges)
