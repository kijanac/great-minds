"""Search service: index rebuild + hybrid BM25+vector retrieval via RRF.

CRUD on the search_index table lives in ``SearchIndexRepository``.
This module owns the search-domain concerns that aren't tied to one
specific table: chunking, embedding batching + MRL truncation, and
Reciprocal Rank Fusion of BM25 and vector results.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import math
from uuid import UUID

from openai import AsyncOpenAI
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.core.llm import EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, get_async_client
from great_minds.core.markdown import paragraphs, parse_frontmatter
from great_minds.core.paths import RAW_GLOB, RAW_PREFIX, WIKI_GLOB, WIKI_PREFIX
from great_minds.core.search.repository import SearchIndexRepository
from great_minds.core.search.schemas import Chunk, SearchResult
from great_minds.core.storage import Storage

log = logging.getLogger(__name__)

RRF_K = 60
MAX_SEARCH_RESULTS = 20
EMBEDDING_BATCH_SIZE = 50
MAX_EMBED_RETRIES = 3


def _chunk_paragraphs(path: str, content: str) -> list[Chunk]:
    """Build search-index chunks from shared paragraph chunking.

    chunk_index aligns with ingest's ``^pN`` anchors and extract's
    anchor.chunk_index, since all three consumers share
    ``markdown.paragraphs()``. Heading text is prepended to body for
    tsvector + embedding so retrieval ranks section context; the
    ``heading`` column stays clean for display.
    """
    chunks: list[Chunk] = []
    for p in paragraphs(content):
        full_text = f"{p.heading}\n\n{p.body}" if p.heading else p.body
        h = hashlib.sha256(full_text.encode()).hexdigest()
        chunks.append(
            Chunk(
                path=path,
                chunk_index=p.index,
                heading=p.heading,
                body=full_text,
                content_hash=h,
            )
        )
    return chunks


def _truncate_and_normalize(embedding: list[float], dims: int) -> list[float]:
    """MRL truncation to target dims, then L2 normalize."""
    truncated = embedding[:dims]
    norm = math.sqrt(sum(x * x for x in truncated))
    if norm == 0:
        return truncated
    return [x / norm for x in truncated]


async def _embed_batch(client: AsyncOpenAI, texts: list[str]) -> list[list[float]]:
    """Embed a batch of texts via OpenRouter with retries + MRL truncation."""
    for attempt in range(1, MAX_EMBED_RETRIES + 1):
        try:
            response = await client.embeddings.create(
                model=EMBEDDING_MODEL, input=texts
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
    raise AssertionError("_embed_batch loop exited without resolution")


async def _rebuild_scope(
    session: AsyncSession,
    brain_id: UUID,
    storage: Storage,
    *,
    glob_pattern: str,
    path_prefix: str,
    client: AsyncOpenAI | None = None,
) -> int:
    """Rebuild search_index rows whose path is inside ``path_prefix/``.

    Scoping is load-bearing: without it, rebuilding one scope (say
    ``wiki/``) would delete rows of another scope (``raw/``) as
    stale. All existing-row queries and stale-deletions constrain to
    ``path LIKE path_prefix%``.
    """
    if client is None:
        client = get_async_client()
    repo = SearchIndexRepository(session)

    all_chunks: list[Chunk] = []
    for path in storage.glob(glob_pattern):
        filename = path.rsplit("/", 1)[-1]
        if filename.startswith("_"):
            continue
        content = storage.read(path)
        if content:
            _, body = parse_frontmatter(content)
            all_chunks.extend(_chunk_paragraphs(path, body))

    existing_hashes = await repo.list_hashes_by_prefix(brain_id, path_prefix)

    if not all_chunks and not existing_hashes:
        log.info(
            "no %s content to index for brain %s",
            path_prefix.rstrip("/"),
            brain_id,
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
        batch_embeddings = await _embed_batch(client, [c.body for c in batch])
        for i, emb in enumerate(batch_embeddings):
            embeddings[batch_start + i] = emb

    current_keys = {(c.path, c.chunk_index) for c in all_chunks}
    stale_keys = list(set(existing_hashes.keys()) - current_keys)
    if stale_keys:
        await repo.delete_by_keys(brain_id, stale_keys)
        log.info(
            "deleted %d stale index entries (scope=%s)",
            len(stale_keys),
            path_prefix.rstrip("/"),
        )

    for i, chunk in enumerate(changed_chunks):
        await repo.upsert_chunk(brain_id, chunk, embeddings[i])

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
        glob_pattern=RAW_GLOB,
        path_prefix=RAW_PREFIX,
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
        glob_pattern=WIKI_GLOB,
        path_prefix=WIKI_PREFIX,
        client=client,
    )


async def count_chunks_by_prefix(
    session: AsyncSession, brain_id: UUID, path_prefix: str
) -> int:
    """Count indexed chunks whose path starts with ``path_prefix``."""
    return await SearchIndexRepository(session).count_by_prefix(
        brain_id, path_prefix
    )


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

    repo = SearchIndexRepository(session)
    client = get_async_client()

    query_embeddings = await _embed_batch(client, [query])
    query_embedding = query_embeddings[0]

    bm25_rows = await repo.bm25_search(brain_ids, query, limit * 2)
    vector_rows = await repo.vector_search(brain_ids, query_embedding, limit * 2)

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

    results: list[SearchResult] = []
    for (brain_id, path, chunk_index), score in ranked:
        heading, body = metadata[(brain_id, path, chunk_index)]
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
