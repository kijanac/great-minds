"""Search indexer: build and query the hybrid BM25 + vector search index.

Reads wiki markdown files from a brain's storage, chunks them by heading,
and upserts into the search_index table with tsvector (BM25) and vector
embeddings. Uses SHA-256 content hashing to skip re-embedding unchanged
chunks.

Query path combines BM25 (ts_rank) and vector similarity via Reciprocal
Rank Fusion (RRF).
"""

import asyncio
import hashlib
import logging
import math
import re
from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from openai import AsyncOpenAI
from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    DateTime,
    Integer,
    Text,
    UniqueConstraint,
    func,
    select,
    delete,
    tuple_,
)
from sqlalchemy.dialects.postgresql import TSVECTOR, UUID as PG_UUID
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Mapped, mapped_column

from great_minds.core.db import Base
from great_minds.core.llm import EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, get_async_client
from great_minds.core.storage import Storage

log = logging.getLogger(__name__)

RRF_K = 60
MAX_SEARCH_RESULTS = 20
EMBEDDING_BATCH_SIZE = 50
MAX_EMBED_RETRIES = 3


# ---------------------------------------------------------------------------
# ORM model
# ---------------------------------------------------------------------------


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


# ---------------------------------------------------------------------------
# Chunking
# ---------------------------------------------------------------------------

_HEADING_RE = re.compile(r"^(#{1,3})\s+(.+)$", re.MULTILINE)


@dataclass
class Chunk:
    path: str
    chunk_index: int
    heading: str
    body: str
    content_hash: str


def _chunk_article(path: str, content: str) -> list[Chunk]:
    """Split a wiki article into chunks by heading boundaries.

    Each chunk contains the heading and all text until the next heading
    of equal or higher level. Articles with no headings become a single chunk.
    """
    headings = list(_HEADING_RE.finditer(content))

    if not headings:
        body = content.strip()
        if not body:
            return []
        h = hashlib.sha256(body.encode()).hexdigest()
        return [Chunk(path=path, chunk_index=0, heading="", body=body, content_hash=h)]

    chunks: list[Chunk] = []

    preamble = content[: headings[0].start()].strip()
    if preamble:
        h = hashlib.sha256(preamble.encode()).hexdigest()
        chunks.append(
            Chunk(path=path, chunk_index=0, heading="", body=preamble, content_hash=h)
        )

    for i, match in enumerate(headings):
        heading_text = match.group(2).strip()
        start = match.end()
        end = headings[i + 1].start() if i + 1 < len(headings) else len(content)
        body = content[start:end].strip()

        if not body and not heading_text:
            continue

        full_text = f"{heading_text}\n\n{body}" if body else heading_text
        h = hashlib.sha256(full_text.encode()).hexdigest()
        chunks.append(
            Chunk(
                path=path,
                chunk_index=len(chunks),
                heading=heading_text,
                body=full_text,
                content_hash=h,
            )
        )

    return chunks


# ---------------------------------------------------------------------------
# Embedding
# ---------------------------------------------------------------------------


def _truncate_and_normalize(embedding: list[float], dims: int) -> list[float]:
    """MRL truncation to target dims, then L2 normalize."""
    truncated = embedding[:dims]
    norm = math.sqrt(sum(x * x for x in truncated))
    if norm == 0:
        return truncated
    return [x / norm for x in truncated]


async def _embed_batch(client: AsyncOpenAI, texts: list[str]) -> list[list[float]]:
    """Get embeddings for a batch of texts via OpenRouter, with retries and MRL truncation."""
    for attempt in range(1, MAX_EMBED_RETRIES + 1):
        try:
            response = await client.embeddings.create(
                model=EMBEDDING_MODEL,
                input=texts,
            )
            return [
                _truncate_and_normalize(item.embedding, EMBEDDING_DIMENSIONS)
                for item in response.data
            ]
        except Exception as e:
            if attempt == MAX_EMBED_RETRIES:
                raise
            log.warning(
                "embedding batch failed (attempt %d/%d): %s",
                attempt,
                MAX_EMBED_RETRIES,
                e,
            )
            await asyncio.sleep(2**attempt)


# ---------------------------------------------------------------------------
# Index build
# ---------------------------------------------------------------------------


async def rebuild_index(
    session: AsyncSession,
    brain_id: UUID,
    storage: Storage,
) -> int:
    """Rebuild the search index for a brain from its wiki markdown files.

    Uses content hashing to skip re-embedding unchanged chunks.
    Embeddings are only computed for new/changed chunks (expensive).

    Returns the number of chunks indexed.
    """
    client = get_async_client()

    all_chunks: list[Chunk] = []
    for path in storage.glob("wiki/*.md"):
        filename = path.rsplit("/", 1)[-1]
        if filename.startswith("_"):
            continue
        content = storage.read(path)
        if content:
            all_chunks.extend(_chunk_article(path, content))

    if not all_chunks:
        log.info("no wiki content to index for brain %s", brain_id)
        return 0

    # Load existing hashes to detect unchanged chunks
    existing = await session.execute(
        select(
            SearchIndexEntry.path,
            SearchIndexEntry.chunk_index,
            SearchIndexEntry.content_hash,
        ).where(SearchIndexEntry.brain_id == brain_id)
    )
    existing_hashes: dict[tuple[str, int], str] = {
        (row.path, row.chunk_index): row.content_hash for row in existing
    }

    changed_chunks: list[Chunk] = []
    for chunk in all_chunks:
        key = (chunk.path, chunk.chunk_index)
        if existing_hashes.get(key) != chunk.content_hash:
            changed_chunks.append(chunk)

    log.info(
        "brain %s: %d total chunks, %d changed, %d unchanged",
        brain_id,
        len(all_chunks),
        len(changed_chunks),
        len(all_chunks) - len(changed_chunks),
    )

    # Embed changed chunks in batches
    embeddings: dict[int, list[float]] = {}
    for batch_start in range(0, len(changed_chunks), EMBEDDING_BATCH_SIZE):
        batch = changed_chunks[batch_start : batch_start + EMBEDDING_BATCH_SIZE]
        texts = [c.body for c in batch]
        batch_embeddings = await _embed_batch(client, texts)
        for i, emb in enumerate(batch_embeddings):
            embeddings[batch_start + i] = emb

    # Bulk delete stale entries (paths/chunks that no longer exist)
    current_keys = {(c.path, c.chunk_index) for c in all_chunks}
    stale_keys = set(existing_hashes.keys()) - current_keys
    if stale_keys:
        stale_list = list(stale_keys)
        await session.execute(
            delete(SearchIndexEntry).where(
                SearchIndexEntry.brain_id == brain_id,
                tuple_(SearchIndexEntry.path, SearchIndexEntry.chunk_index).in_(
                    stale_list
                ),
            )
        )
        log.info("deleted %d stale index entries", len(stale_list))

    # Upsert changed chunks (with new embeddings + tsvector)
    for i, chunk in enumerate(changed_chunks):
        entry = await session.execute(
            select(SearchIndexEntry).where(
                SearchIndexEntry.brain_id == brain_id,
                SearchIndexEntry.path == chunk.path,
                SearchIndexEntry.chunk_index == chunk.chunk_index,
            )
        )
        existing_entry = entry.scalar_one_or_none()

        if existing_entry:
            existing_entry.heading = chunk.heading
            existing_entry.body = chunk.body
            existing_entry.content_hash = chunk.content_hash
            existing_entry.tsv = func.to_tsvector("english", chunk.body)
            existing_entry.embedding = embeddings[i]
            existing_entry.updated_at = func.now()
        else:
            session.add(
                SearchIndexEntry(
                    brain_id=brain_id,
                    path=chunk.path,
                    chunk_index=chunk.chunk_index,
                    heading=chunk.heading,
                    body=chunk.body,
                    content_hash=chunk.content_hash,
                    tsv=func.to_tsvector("english", chunk.body),
                    embedding=embeddings[i],
                )
            )

    await session.commit()
    log.info(
        "indexed %d chunks for brain %s (%d embedded)",
        len(all_chunks),
        brain_id,
        len(changed_chunks),
    )
    return len(all_chunks)


# ---------------------------------------------------------------------------
# Hybrid search (BM25 + vector via RRF)
# ---------------------------------------------------------------------------


@dataclass
class SearchResult:
    path: str
    heading: str
    snippet: str
    score: float


async def search(
    session: AsyncSession,
    brain_ids: list[UUID],
    query: str,
    *,
    limit: int = MAX_SEARCH_RESULTS,
) -> list[SearchResult]:
    """Hybrid search across brains using BM25 + vector similarity + RRF."""
    if not brain_ids or not query.strip():
        return []

    client = get_async_client()

    # Query embedding (reuse _embed_batch for retries + MRL truncation)
    query_embeddings = await _embed_batch(client, [query])
    query_embedding = query_embeddings[0]

    # BM25 search — OR individual terms for broad recall, each safely tokenized.
    # plainto_tsquery on each word avoids injection; ts_rank scores higher
    # when more terms match.
    words = [w for w in re.sub(r"[^\w\s]", "", query).split() if len(w) > 2]
    if words:
        tsquery = func.plainto_tsquery("english", words[0])
        for w in words[1:]:
            tsquery = tsquery.bool_op("||")(func.plainto_tsquery("english", w))
    else:
        tsquery = func.plainto_tsquery("english", query)
    rank_expr = func.ts_rank(SearchIndexEntry.tsv, tsquery)
    bm25_results = await session.execute(
        select(
            SearchIndexEntry.path,
            SearchIndexEntry.chunk_index,
            SearchIndexEntry.heading,
            SearchIndexEntry.body,
            rank_expr.label("rank"),
        )
        .where(
            SearchIndexEntry.brain_id.in_(brain_ids),
            SearchIndexEntry.tsv.bool_op("@@")(tsquery),
        )
        .order_by(rank_expr.desc())
        .limit(limit * 2)
    )
    bm25_rows = bm25_results.fetchall()

    # Vector search
    dist_expr = SearchIndexEntry.embedding.cosine_distance(query_embedding)
    vector_results = await session.execute(
        select(
            SearchIndexEntry.path,
            SearchIndexEntry.chunk_index,
            SearchIndexEntry.heading,
            SearchIndexEntry.body,
            (1 - dist_expr).label("similarity"),
        )
        .where(
            SearchIndexEntry.brain_id.in_(brain_ids),
            SearchIndexEntry.embedding.isnot(None),
        )
        .order_by(dist_expr)
        .limit(limit * 2)
    )
    vector_rows = vector_results.fetchall()

    # RRF fusion — deduplicate by (path, chunk_index) across brains
    scores: dict[tuple[str, int], float] = {}
    metadata: dict[tuple[str, int], tuple[str, str]] = {}

    for rank, row in enumerate(bm25_rows):
        key = (row.path, row.chunk_index)
        if key not in scores:
            scores[key] = 0
            metadata[key] = (row.heading, row.body)
        scores[key] += 1.0 / (RRF_K + rank + 1)

    for rank, row in enumerate(vector_rows):
        key = (row.path, row.chunk_index)
        if key not in scores:
            scores[key] = 0
            metadata[key] = (row.heading, row.body)
        scores[key] += 1.0 / (RRF_K + rank + 1)

    ranked = sorted(scores.items(), key=lambda x: x[1], reverse=True)[:limit]

    results = []
    for (path, _chunk_index), score in ranked:
        heading, body = metadata[(path, _chunk_index)]
        snippet = body[:500] if len(body) > 500 else body
        results.append(
            SearchResult(path=path, heading=heading, snippet=snippet, score=score)
        )

    return results
