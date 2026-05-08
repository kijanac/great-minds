"""Search package — hybrid retrieval, index rebuild, and diagnostics.

Public surface:

- ``SearchIndexEntry`` (ORM) — imported by Alembic for schema registration.
- ``SearchIndexRepository`` — CRUD + ranking queries on search_index.
- ``SearchService`` — route-facing facade: retrieval, rebuild, diagnostics.
- ``Chunk`` / ``ChunkScore`` / ``SearchResult`` — pydantic schemas.
"""

from great_minds.core.search.models import SearchIndexEntry
from great_minds.core.search.repository import SearchIndexRepository
from great_minds.core.search.schemas import Chunk, ChunkScore, SearchResult
from great_minds.core.search.service import (
    MAX_SEARCH_RESULTS,
    SearchService,
)

__all__ = [
    "Chunk",
    "ChunkScore",
    "MAX_SEARCH_RESULTS",
    "SearchIndexEntry",
    "SearchIndexRepository",
    "SearchResult",
    "SearchService",
]
