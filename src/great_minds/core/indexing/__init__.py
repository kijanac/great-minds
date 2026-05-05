"""Index rebuild pipeline: chunking, embedding, and search-index population.

Streams files from storage, chunks them via ``markdown.paragraphs()``,
diffs against existing content hashes, embeds changed chunks through
OpenRouter with bounded concurrency, and writes results to the
``search_index`` table via ``SearchIndexRepository``.

Public entry points
-------------------
- ``rebuild_raw_index`` — rebuild index entries for ``raw/`` scope.
- ``rebuild_wiki_index`` — rebuild index entries for ``wiki/`` scope.
- ``count_chunks_by_prefix`` — count indexed chunks in a scope.
"""

from great_minds.core.indexing.service import (
    count_chunks_by_prefix,
    rebuild_raw_index,
    rebuild_wiki_index,
)

__all__ = [
    "count_chunks_by_prefix",
    "rebuild_raw_index",
    "rebuild_wiki_index",
]
