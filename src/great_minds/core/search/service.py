"""Search service: hybrid BM25+vector retrieval via Reciprocal Rank Fusion.

Index rebuild (chunking, embedding, index population) lives in
``core.indexing``. This module owns only retrieval: combining BM25
full-text and vector similarity results with RRF.
"""

import logging
from uuid import UUID

from great_minds.core.llm import embed_batch, get_async_client
from great_minds.core.search.repository import SearchIndexRepository
from great_minds.core.search.schemas import SearchResult

log = logging.getLogger(__name__)

RRF_K = 60
MAX_SEARCH_RESULTS = 20


async def search(
    repo: SearchIndexRepository,
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
