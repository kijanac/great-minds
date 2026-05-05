"""Index rebuild orchestration.

Streams files → chunks → hashes → embeds → search_index rows.
See ``core.indexing.__init__`` for the public API.
"""

import asyncio
import logging
from uuid import UUID

from openai import AsyncOpenAI
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.core.hashing import content_hash
from great_minds.core.llm import embed_batch, get_async_client
from great_minds.core.markdown import paragraphs, parse_frontmatter
from great_minds.core.paths import RAW_GLOB, RAW_PREFIX, WIKI_GLOB, WIKI_PREFIX
from great_minds.core.search.repository import SearchIndexRepository
from great_minds.core.search.schemas import Chunk
from great_minds.core.settings import get_settings
from great_minds.core.storage import Storage

log = logging.getLogger(__name__)

EMBEDDING_BATCH_SIZE = 50


# ---------------------------------------------------------------------------
# Chunking
# ---------------------------------------------------------------------------


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


# ---------------------------------------------------------------------------
# Embedding
# ---------------------------------------------------------------------------


async def _embed_and_write(
    client: AsyncOpenAI,
    repo: SearchIndexRepository,
    vault_id: UUID,
    batch: list[Chunk],
    sem: asyncio.Semaphore,
) -> int:
    """Embed one batch of chunks and write results to DB."""
    async with sem:
        embeddings = await embed_batch(client, [c.body for c in batch])
        for chunk, emb in zip(batch, embeddings):
            await repo.upsert_chunk(vault_id, chunk, emb)
        return len(batch)


async def _embed_worker(
    queue: asyncio.Queue,
    client: AsyncOpenAI,
    repo: SearchIndexRepository,
    vault_id: UUID,
    sem: asyncio.Semaphore,
) -> int:
    """Pull batches from queue, embed them, write to DB. Returns total."""
    count = 0
    while True:
        batch = await queue.get()
        if batch is None:
            queue.task_done()
            break
        count += await _embed_and_write(client, repo, vault_id, batch, sem)
        queue.task_done()
    return count


# ---------------------------------------------------------------------------
# Scope rebuild
# ---------------------------------------------------------------------------


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

    # 2. Set up a producer-consumer pipeline: file reader produces batches
    #    into a queue, a fixed pool of workers consumes them, embedding
    #    and writing to DB with bounded concurrency.
    concurrency = max(1, settings.compile_enrich_concurrency // 4)
    embed_sem = asyncio.Semaphore(concurrency)
    queue: asyncio.Queue = asyncio.Queue(maxsize=concurrency * 2)

    workers = [
        asyncio.create_task(_embed_worker(queue, client, repo, vault_id, embed_sem))
        for _ in range(concurrency)
    ]

    total_chunks = 0
    changed_count = 0
    current_keys: list[tuple[str, int]] = []
    batch_buffer: list[Chunk] = []

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
                    await queue.put(batch_buffer)
                    batch_buffer = []

    # Flush final partial batch.
    if batch_buffer:
        await queue.put(batch_buffer)

    # Signal workers to exit.
    for _ in workers:
        await queue.put(None)

    await queue.join()
    embedded_total = sum(await asyncio.gather(*workers, return_exceptions=False))

    if not total_chunks and not existing_hashes:
        log.info(
            "no %s content to index for vault %s",
            path_prefix.rstrip("/"),
            vault_id,
        )
        return 0

    # 3. Delete stale entries (paths no longer present).
    stale_count = await repo.delete_stale_in_scope(vault_id, path_prefix, current_keys)
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


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


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
    return await SearchIndexRepository(session).count_by_prefix(vault_id, path_prefix)
