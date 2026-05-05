"""Search package — BM25 + vector hybrid retrieval.

Public surface:

- ``SearchIndexEntry`` (ORM) — imported by Alembic for schema registration.
- ``SearchIndexRepository`` — CRUD + ranking queries on search_index.
- ``Chunk`` / ``ChunkScore`` / ``SearchResult`` — pydantic schemas.
- ``search`` — hybrid retrieval across vaults.

Index rebuild lives in ``core.indexing``.
"""

from great_minds.core.search.models import SearchIndexEntry
from great_minds.core.search.repository import SearchIndexRepository
from great_minds.core.search.schemas import Chunk, ChunkScore, SearchResult
from great_minds.core.search.service import (
    MAX_SEARCH_RESULTS,
    search,
)

__all__ = [
    "Chunk",
    "ChunkScore",
    "MAX_SEARCH_RESULTS",
    "SearchIndexEntry",
    "SearchIndexRepository",
    "SearchResult",
    "search",
]
