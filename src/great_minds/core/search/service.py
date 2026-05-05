"""Search service: index rebuild + hybrid BM25+vector retrieval via RRF.

CRUD on the search_index table lives in ``SearchIndexRepository``.
This module owns the search-domain concerns that aren't tied to one
specific table: chunking, embedding batching + MRL truncation, and
Reciprocal Rank Fusion of BM25 and vector results.
"""


import asyncio
import logging
import math
from uuid import UUID

from great_minds.core.hashing import content_hash

from openai import AsyncOpenAI
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.core.llm import EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, get_async_client
from great_minds.core.markdown import paragraphs, parse_frontmatter
from great_minds.core.paths import RAW_GLOB, RAW_PREFIX, WIKI_GLOB, WIKI_PREFIX
from great_minds.core.search.repository import SearchIndexRepository
from great_minds.core.search.schemas import Chunk, SearchResult
from great_minds.core.settings import get_settings
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
        h = content_hash("chunk", full_text)
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
    vault_id: UUID,
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

    Files are streamed one at a time — chunks are batched and sent to
    the embedding API as soon as a full batch accumulates, avoiding
    loading all file contents into memory simultaneously.
    """
    if client is None:
        client = get_async_client()
    repo = SearchIndexRepository(session)
    settings = get_settings()

    # 1. Fetch existing hashes for change detection.
    hash_entries = await repo.list_hashes_by_prefix(vault_id, path_prefix)
    existing_hashes = {(e.path, e.chunk_index): e.content_hash for e in hash_entries}

    # 2. Stream files, batch changed chunks for embedding.
    total_chunks = 0
    changed_count = 0
    current_keys: list[tuple[str, int]] = []
    embed_sem = asyncio.Semaphore(
        max(1, settings.compile_enrich_concurrency // 4)
    )

    async def _embed_and_write(batch: list[Chunk]) -> int:
        """Embed one batch and write results to DB. Returns batch size."""
        async with embed_sem:
            bodies = [c.body for c in batch]
            try:
                embeddings = await _embed_batch(client, bodies)
            except Exception:
                log.error("embed batch failed for %d chunks", len(batch))
                raise
            for chunk, emb in zip(batch, embeddings):
                await repo.upsert_chunk(vault_id, chunk, emb)
            return len(batch)

    batch_buffer: list[Chunk] = []
    pending_tasks: list[asyncio.Task[int]] = []
    paths = await storage.glob(glob_pattern)

    for path in paths:
        filename = path.rsplit("/", 1)[-1]
        if filename.startswith("_"):
            continue
        content = await storage.read(path)
        if not content:
            continue
        _, body = parse_frontmatter(content)
        for chunk in _chunk_paragraphs(path, body):
            total_chunks += 1
            key = (chunk.path, chunk.chunk_index)
            current_keys.append(key)
            if existing_hashes.get(key) != chunk.content_hash:
                changed_count += 1
                batch_buffer.append(chunk)
                if len(batch_buffer) >= EMBEDDING_BATCH_SIZE:
                    batch = batch_buffer[:]
                    batch_buffer.clear()
                    pending_tasks.append(
                        asyncio.create_task(_embed_and_write(batch))
                    )

    # Flush final partial batch.
    if batch_buffer:
        pending_tasks.append(
            asyncio.create_task(_embed_and_write(batch_buffer))
        )

    # Wait for all in-flight embedding batches.
    if pending_tasks:
        embedded_total = sum(
            await asyncio.gather(*pending_tasks, return_exceptions=False)
        )
    else:
        embedded_total = 0

    if not total_chunks and not existing_hashes:
        log.info(
            "no %s content to index for vault %s",
            path_prefix.rstrip("/"),
            vault_id,
        )
        return 0

    # 3. Delete stale entries (paths no longer present).
    stale_count = await repo.delete_stale_in_scope(
        vault_id, path_prefix, current_keys
    )
    if stale_count:
        log.info(
            "deleted %d stale index entries (scope=%s)",
            stale_count,
            path_prefix.rstrip("/"),
        )

    await session.commit()
    log.info(
        "vault %s scope=%s: %d total chunks, %d changed (%d embedded), %d unchanged",
        vault_id,
        path_prefix.rstrip("/"),
        total_chunks,
        changed_count,
        embedded_total,
        total_chunks - changed_count,
    )
    return total_chunks


async def rebuild_raw_index(
    session: AsyncSession,
    vault_id: UUID,
    storage: Storage,
    *,
    client: AsyncOpenAI | None = None,
) -> int:
    return await _rebuild_scope(
        session,
        vault_id,
        storage,
        glob_pattern=RAW_GLOB,
        path_prefix=RAW_PREFIX,
        client=client,
    )


async def rebuild_wiki_index(
    session: AsyncSession,
    vault_id: UUID,
    storage: Storage,
    *,
    client: AsyncOpenAI | None = None,
) -> int:
    return await _rebuild_scope(
        session,
        vault_id,
        storage,
        glob_pattern=WIKI_GLOB,
        path_prefix=WIKI_PREFIX,
        client=client,
    )


async def count_chunks_by_prefix(
    session: AsyncSession, vault_id: UUID, path_prefix: str
) -> int:
    """Count indexed chunks whose path starts with ``path_prefix``."""
    return await SearchIndexRepository(session).count_by_prefix(
        vault_id, path_prefix
    )


async def search(
    session: AsyncSession,
    vault_ids: list[UUID],
    query: str,
    *,
    limit: int = MAX_SEARCH_RESULTS,
) -> list[SearchResult]:
    """Hybrid search across vaults using BM25 + vector similarity + RRF."""
    if not vault_ids or not query.strip():
        return []

    repo = SearchIndexRepository(session)
    client = get_async_client()

    query_embeddings = await _embed_batch(client, [query])
    query_embedding = query_embeddings[0]

    bm25_rows = await repo.bm25_search(vault_ids, query, limit * 2)
    vector_rows = await repo.vector_search(vault_ids, query_embedding, limit * 2)

    scores: dict[tuple[UUID, str, int], float] = {}
    metadata: dict[tuple[UUID, str, int], tuple[str, str]] = {}

    for rank, row in enumerate(bm25_rows):
        key = (row.vault_id, row.path, row.chunk_index)
        if key not in scores:
            scores[key] = 0
            metadata[key] = (row.heading, row.body)
        scores[key] += 1.0 / (RRF_K + rank + 1)

    for rank, row in enumerate(vector_rows):
        key = (row.vault_id, row.path, row.chunk_index)
        if key not in scores:
            scores[key] = 0
            metadata[key] = (row.heading, row.body)
        scores[key] += 1.0 / (RRF_K + rank + 1)

    ranked = sorted(scores.items(), key=lambda x: x[1], reverse=True)[:limit]

    results: list[SearchResult] = []
    for (vault_id, path, chunk_index), score in ranked:
        heading, body = metadata[(vault_id, path, chunk_index)]
        snippet = body[:500] if len(body) > 500 else body
        results.append(
            SearchResult(
                path=path,
                heading=heading,
                snippet=snippet,
                score=score,
                vault_id=vault_id,
            )
        )
    return results
