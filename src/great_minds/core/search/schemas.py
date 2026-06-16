"""Pydantic schemas for search indexing and retrieval.

- ``Chunk``: pre-persist shape built by the service before the repo
  upserts it. Carries the full body + content_hash ready to embed.
- ``ChunkScore``: a scored row returned by the repository's bm25 /
  vector queries, pre-fusion.
- ``SearchResult``: public, fused-and-ranked result returned to callers.
"""

from uuid import UUID

from pydantic import BaseModel, ConfigDict


class Chunk(BaseModel):
    """A single indexed chunk.

    Built pre-persist by the rebuild path (carrying body + content_hash
    ready to embed) and also hydrated from existing rows by
    ``fetch_window`` for context expansion — hence ``from_attributes``.
    """

    model_config = ConfigDict(from_attributes=True)

    path: str
    chunk_index: int
    heading: str
    body: str
    content_hash: str


class ChunkScore(BaseModel):
    """One ranked row from either BM25 or vector search, pre-fusion."""

    model_config = ConfigDict(from_attributes=True)

    vault_id: UUID
    path: str
    chunk_index: int
    heading: str
    body: str
    score: float


class SearchResult(BaseModel):
    path: str
    chunk_index: int
    heading: str
    snippet: str
    score: float
    vault_id: UUID


class ChunkHash(BaseModel):
    """(path, chunk_index, content_hash) row — used for rebuild diff."""

    model_config = ConfigDict(from_attributes=True)
    path: str
    chunk_index: int
    content_hash: str


class OutlineSection(BaseModel):
    """A run of consecutive chunks sharing one heading.

    Built by ``SearchService.document_outline`` from the heading column of
    the indexed chunks, so the query agent can see a document's structure
    (headings → chunk ranges) and read a section by range instead of
    pulling the whole file.
    """

    heading: str
    start: int
    end: int
