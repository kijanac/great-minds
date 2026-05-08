"""Search service: hybrid BM25+vector retrieval and index rebuild.

Search owns the full lifecycle of the ``search_index`` table:
retrieval (BM25 + vector + RRF), index rebuild (chunking, embedding,
upsert with change detection), and diagnostics (counts).
"""

import asyncio
import logging
from uuid import UUID

from openai import AsyncOpenAI

from great_minds.core.hashing import content_hash
from great_minds.core.llm import embed_batch, get_async_client
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


class SearchService:
    """Route-facing facade over SearchIndexRepository.

    Covers retrieval, rebuild, and diagnostics for the search_index table.
    """

    def __init__(self, repository: SearchIndexRepository) -> None:
        self.repo = repository

    async def _commit(self) -> None:
        await self.repo.session.commit()

    # -- Retrieval --------------------------------------------------------

    async def search(
        self,
        vault_ids: list[UUID],
        query: str,
        *,
        limit: int = MAX_SEARCH_RESULTS,
    ) -> list[SearchResult]:
        """Hybrid search across vaults using BM25 + vector similarity + RRF."""
        if not vault_ids or not query.strip():
            return []

        client = get_async_client()

        query_embeddings = await embed_batch(client, [query])
        query_embedding = query_embeddings[0]

        bm25_rows = await self.repo.bm25_search(vault_ids, query, limit * 2)
        vector_rows = await self.repo.vector_search(
            vault_ids, query_embedding, limit * 2
        )

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

    # -- Diagnostics ------------------------------------------------------

    async def count_by_prefix(self, vault_id: UUID, path_prefix: str) -> int:
        """Count indexed chunks whose path starts with ``path_prefix``."""
        return await self.repo.count_by_prefix(vault_id, path_prefix)

    # -- Rebuild ----------------------------------------------------------

    async def rebuild_raw_index(
        self,
        vault_id: UUID,
        storage: Storage,
        *,
        client: AsyncOpenAI | None = None,
    ) -> int:
        return await self._rebuild_scope(
            vault_id,
            storage,
            glob_pattern=RAW_GLOB,
            path_prefix=RAW_PREFIX,
            client=client,
        )

    async def rebuild_wiki_index(
        self,
        vault_id: UUID,
        storage: Storage,
        *,
        client: AsyncOpenAI | None = None,
    ) -> int:
        return await self._rebuild_scope(
            vault_id,
            storage,
            glob_pattern=WIKI_GLOB,
            path_prefix=WIKI_PREFIX,
            client=client,
        )

    async def _rebuild_scope(
        self,
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
        settings = get_settings()

        # 1. Fetch existing hashes for change detection.
        hash_entries = await self.repo.list_hashes_by_prefix(vault_id, path_prefix)
        existing_hashes = {
            (e.path, e.chunk_index): e.content_hash for e in hash_entries
        }

        # 2. Producer-consumer pipeline: file reader produces batches into
        #    a queue; a fixed pool of workers consumes, embedding and
        #    writing to DB with bounded concurrency.
        concurrency = max(1, settings.compile_enrich_concurrency // 4)
        embed_sem = asyncio.Semaphore(concurrency)
        queue: asyncio.Queue = asyncio.Queue(maxsize=concurrency * 2)

        workers = [
            asyncio.create_task(self._embed_worker(queue, client, vault_id, embed_sem))
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
            for p in paragraphs(body):
                full_text = f"{p.heading}\n\n{p.body}" if p.heading else p.body
                h = content_hash("chunk", full_text)
                chunk = Chunk(
                    path=path,
                    chunk_index=p.index,
                    heading=p.heading,
                    body=full_text,
                    content_hash=h,
                )
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
        stale_count = await self.repo.delete_stale_in_scope(
            vault_id, path_prefix, current_keys
        )
        if stale_count:
            log.info(
                "deleted %d stale index entries (scope=%s)",
                stale_count,
                path_prefix.rstrip("/"),
            )

        await self._commit()
        log.info(
            "vault %s scope=%s: %d total chunks, %d changed (%d embedded), "
            "%d unchanged",
            vault_id,
            path_prefix.rstrip("/"),
            total_chunks,
            changed_count,
            embedded_total,
            total_chunks - changed_count,
        )
        return total_chunks

    # -- Embedding pipeline -----------------------------------------------

    async def _embed_worker(
        self,
        queue: asyncio.Queue,
        client: AsyncOpenAI,
        vault_id: UUID,
        sem: asyncio.Semaphore,
    ) -> int:
        """Pull batches from queue, embed, write to DB. Returns total."""
        count = 0
        while True:
            batch = await queue.get()
            if batch is None:
                queue.task_done()
                break
            async with sem:
                embeddings = await embed_batch(client, [c.body for c in batch])
                await self.repo.batch_upsert(vault_id, list(zip(batch, embeddings)))
                count += len(batch)
            queue.task_done()
        return count
