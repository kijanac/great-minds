"""Search package — BM25 + vector hybrid retrieval.

Public surface:

- ``SearchIndexEntry`` (ORM) — imported by Alembic for schema registration.
- ``SearchIndexRepository`` — CRUD + ranking queries on search_index.
- ``Chunk`` / ``ChunkScore`` / ``SearchResult`` — pydantic schemas.
- ``rebuild_raw_index`` / ``rebuild_wiki_index`` — orchestration entry points.
- ``count_chunks_by_prefix`` — diagnostic count used by publish's compile log.
- ``search`` — hybrid retrieval across vaults.
- ``_truncate_and_normalize`` — MRL + L2-normalize helper shared with extract.
"""

from great_minds.core.search.models import SearchIndexEntry
from great_minds.core.search.repository import SearchIndexRepository
from great_minds.core.search.schemas import Chunk, ChunkScore, SearchResult
from great_minds.core.search.service import (
    MAX_SEARCH_RESULTS,
    _truncate_and_normalize,
    count_chunks_by_prefix,
    rebuild_raw_index,
    rebuild_wiki_index,
    search,
)

__all__ = [
    "Chunk",
    "ChunkScore",
    "MAX_SEARCH_RESULTS",
    "SearchIndexEntry",
    "SearchIndexRepository",
    "SearchResult",
    "_truncate_and_normalize",
    "count_chunks_by_prefix",
    "rebuild_raw_index",
    "rebuild_wiki_index",
    "search",
]
