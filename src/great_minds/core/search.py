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

from great_minds.core.brain_utils import parse_frontmatter
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

_HEADING_LINE_RE = re.compile(r"^(#{1,6})\s+(.+)$")
_PARA_SPLIT_RE = re.compile(r"\n\s*\n")


@dataclass
class Chunk:
    path: str
    chunk_index: int
    heading: str
    body: str
    content_hash: str


def _chunk_paragraphs(path: str, content: str) -> list[Chunk]:
    """Paragraph-level chunking with heading metadata carried forward.

    Walks blank-line-separated blocks. Heading blocks (`# Foo`) update
    the running section context and produce no chunk of their own; body
    blocks emit a chunk whose `heading` column is the nearest preceding
    heading. The heading text is prepended to `body` for tsvector +
    embedding so retrieval ranks section context, while the `heading`
    column stays clean for display.

    One chunker for both raw and wiki — differences are scope (path
    prefix), not chunking strategy.
    """
    chunks: list[Chunk] = []
    current_heading = ""

    for block in _PARA_SPLIT_RE.split(content):
        block = block.strip()
        if not block:
            continue

        first_line, _, rest = block.partition("\n")
        heading_match = _HEADING_LINE_RE.match(first_line)
        if heading_match:
            current_heading = heading_match.group(2).strip()
            body = rest.strip()
            if not body:
                continue
        else:
            body = block

        full_text = f"{current_heading}\n\n{body}" if current_heading else body
        h = hashlib.sha256(full_text.encode()).hexdigest()
        chunks.append(
            Chunk(
                path=path,
                chunk_index=len(chunks),
                heading=current_heading,
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


async def _rebuild_scope(
    session: AsyncSession,
    brain_id: UUID,
    storage: Storage,
    *,
    glob_pattern: str,
    path_prefix: str,
    client: AsyncOpenAI | None = None,
) -> int:
    """Rebuild search_index rows whose path is inside path_prefix/.

    Scoping is load-bearing: without it, rebuilding one scope (say
    wiki/) would delete rows of another scope (raw/) as "stale." Every
    existing-row query and stale-deletion is constrained to
    path LIKE path_prefix%.
    """
    if client is None:
        client = get_async_client()

    all_chunks: list[Chunk] = []
    for path in storage.glob(glob_pattern):
        filename = path.rsplit("/", 1)[-1]
        if filename.startswith("_"):
            continue
        content = storage.read(path)
        if content:
            _, body = parse_frontmatter(content)
            all_chunks.extend(_chunk_paragraphs(path, body))

    existing = await session.execute(
        select(
            SearchIndexEntry.path,
            SearchIndexEntry.chunk_index,
            SearchIndexEntry.content_hash,
        ).where(
            SearchIndexEntry.brain_id == brain_id,
            SearchIndexEntry.path.like(f"{path_prefix}%"),
        )
    )
    existing_hashes: dict[tuple[str, int], str] = {
        (row.path, row.chunk_index): row.content_hash for row in existing
    }

    if not all_chunks and not existing_hashes:
        log.info(
            "no %s content to index for brain %s", path_prefix.rstrip("/"), brain_id
        )
        return 0

    changed_chunks: list[Chunk] = []
    for chunk in all_chunks:
        key = (chunk.path, chunk.chunk_index)
        if existing_hashes.get(key) != chunk.content_hash:
            changed_chunks.append(chunk)

    log.info(
        "brain %s scope=%s: %d total chunks, %d changed, %d unchanged",
        brain_id,
        path_prefix.rstrip("/"),
        len(all_chunks),
        len(changed_chunks),
        len(all_chunks) - len(changed_chunks),
    )

    embeddings: dict[int, list[float]] = {}
    for batch_start in range(0, len(changed_chunks), EMBEDDING_BATCH_SIZE):
        batch = changed_chunks[batch_start : batch_start + EMBEDDING_BATCH_SIZE]
        texts = [c.body for c in batch]
        batch_embeddings = await _embed_batch(client, texts)
        for i, emb in enumerate(batch_embeddings):
            embeddings[batch_start + i] = emb

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
        log.info(
            "deleted %d stale index entries (scope=%s)",
            len(stale_list),
            path_prefix.rstrip("/"),
        )

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
        "indexed %d chunks for brain %s scope=%s (%d embedded)",
        len(all_chunks),
        brain_id,
        path_prefix.rstrip("/"),
        len(changed_chunks),
    )
    return len(all_chunks)


async def rebuild_raw_index(
    session: AsyncSession,
    brain_id: UUID,
    storage: Storage,
    *,
    client: AsyncOpenAI | None = None,
) -> int:
    return await _rebuild_scope(
        session,
        brain_id,
        storage,
        glob_pattern="raw/**/*.md",
        path_prefix="raw/",
        client=client,
    )


async def rebuild_wiki_index(
    session: AsyncSession,
    brain_id: UUID,
    storage: Storage,
    *,
    client: AsyncOpenAI | None = None,
) -> int:
    return await _rebuild_scope(
        session,
        brain_id,
        storage,
        glob_pattern="wiki/*.md",
        path_prefix="wiki/",
        client=client,
    )


# ---------------------------------------------------------------------------
# Hybrid search (BM25 + vector via RRF)
# ---------------------------------------------------------------------------


@dataclass
class SearchResult:
    path: str
    heading: str
    snippet: str
    score: float
    brain_id: UUID


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
            SearchIndexEntry.brain_id,
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
            SearchIndexEntry.brain_id,
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

    # RRF fusion — deduplicate by (brain_id, path, chunk_index)
    scores: dict[tuple[UUID, str, int], float] = {}
    metadata: dict[tuple[UUID, str, int], tuple[str, str]] = {}

    for rank, row in enumerate(bm25_rows):
        key = (row.brain_id, row.path, row.chunk_index)
        if key not in scores:
            scores[key] = 0
            metadata[key] = (row.heading, row.body)
        scores[key] += 1.0 / (RRF_K + rank + 1)

    for rank, row in enumerate(vector_rows):
        key = (row.brain_id, row.path, row.chunk_index)
        if key not in scores:
            scores[key] = 0
            metadata[key] = (row.heading, row.body)
        scores[key] += 1.0 / (RRF_K + rank + 1)

    ranked = sorted(scores.items(), key=lambda x: x[1], reverse=True)[:limit]

    results = []
    for (brain_id, path, _chunk_index), score in ranked:
        heading, body = metadata[(brain_id, path, _chunk_index)]
        snippet = body[:500] if len(body) > 500 else body
        results.append(
            SearchResult(
                path=path,
                heading=heading,
                snippet=snippet,
                score=score,
                brain_id=brain_id,
            )
        )

    return results
