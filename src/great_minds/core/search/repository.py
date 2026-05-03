"""SearchIndexRepository — CRUD + ranking queries on search_index.

All SQL that touches SearchIndexEntry lives here. The service layer
calls these methods with already-built inputs (Chunk + embedding,
tokenized BM25 query string, query embedding vector) and never sees
a tsquery or cosine operator.
"""


import re
from uuid import UUID

from sqlalchemy import delete, func, select, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.core.search.models import SearchIndexEntry
from great_minds.core.search.schemas import Chunk, ChunkScore


class SearchIndexRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    # -- Rebuild / upsert path -------------------------------------------

    async def list_hashes_by_prefix(
        self, vault_id: UUID, path_prefix: str
    ) -> dict[tuple[str, int], str]:
        """Return {(path, chunk_index): content_hash} for diff during rebuild."""
        rows = await self.session.execute(
            select(
                SearchIndexEntry.path,
                SearchIndexEntry.chunk_index,
                SearchIndexEntry.content_hash,
            ).where(
                SearchIndexEntry.vault_id == vault_id,
                SearchIndexEntry.path.like(f"{path_prefix}%"),
            )
        )
        return {(r.path, r.chunk_index): r.content_hash for r in rows}

    async def delete_by_keys(
        self, vault_id: UUID, keys: list[tuple[str, int]]
    ) -> None:
        """Bulk delete rows matching (path, chunk_index) pairs."""
        if not keys:
            return
        await self.session.execute(
            delete(SearchIndexEntry).where(
                SearchIndexEntry.vault_id == vault_id,
                tuple_(SearchIndexEntry.path, SearchIndexEntry.chunk_index).in_(keys),
            )
        )

    async def upsert_chunk(
        self,
        vault_id: UUID,
        chunk: Chunk,
        embedding: list[float] | None,
    ) -> None:
        """Insert or update a single chunk with its precomputed embedding."""
        existing = await self.session.execute(
            select(SearchIndexEntry).where(
                SearchIndexEntry.vault_id == vault_id,
                SearchIndexEntry.path == chunk.path,
                SearchIndexEntry.chunk_index == chunk.chunk_index,
            )
        )
        row = existing.scalar_one_or_none()
        tsv = func.to_tsvector("english", chunk.body)
        if row is not None:
            row.heading = chunk.heading
            row.body = chunk.body
            row.content_hash = chunk.content_hash
            row.tsv = tsv
            row.embedding = embedding
            row.updated_at = func.now()
            return
        self.session.add(
            SearchIndexEntry(
                vault_id=vault_id,
                path=chunk.path,
                chunk_index=chunk.chunk_index,
                heading=chunk.heading,
                body=chunk.body,
                content_hash=chunk.content_hash,
                tsv=tsv,
                embedding=embedding,
            )
        )

    # -- Diagnostics -----------------------------------------------------

    async def count_by_prefix(
        self, vault_id: UUID, path_prefix: str
    ) -> int:
        return (
            await self.session.scalar(
                select(func.count())
                .select_from(SearchIndexEntry)
                .where(
                    SearchIndexEntry.vault_id == vault_id,
                    SearchIndexEntry.path.like(f"{path_prefix}%"),
                )
            )
        ) or 0

    # -- Query path ------------------------------------------------------

    async def bm25_search(
        self, vault_ids: list[UUID], query: str, limit: int
    ) -> list[ChunkScore]:
        """Return top-N rows by ts_rank against a tokenized BM25 tsquery.

        Builds the tsquery internally — callers pass the raw user query
        string and this method tokenizes (strips non-word chars, drops
        words <=2 chars, OR-joins the rest via plainto_tsquery).
        """
        words = [w for w in re.sub(r"[^\w\s]", "", query).split() if len(w) > 2]
        if words:
            tsquery = func.plainto_tsquery("english", words[0])
            for w in words[1:]:
                tsquery = tsquery.bool_op("||")(func.plainto_tsquery("english", w))
        else:
            tsquery = func.plainto_tsquery("english", query)
        rank_expr = func.ts_rank(SearchIndexEntry.tsv, tsquery)
        result = await self.session.execute(
            select(
                SearchIndexEntry.vault_id,
                SearchIndexEntry.path,
                SearchIndexEntry.chunk_index,
                SearchIndexEntry.heading,
                SearchIndexEntry.body,
                rank_expr.label("score"),
            )
            .where(
                SearchIndexEntry.vault_id.in_(vault_ids),
                SearchIndexEntry.tsv.bool_op("@@")(tsquery),
            )
            .order_by(rank_expr.desc())
            .limit(limit)
        )
        return [
            ChunkScore(
                vault_id=row.vault_id,
                path=row.path,
                chunk_index=row.chunk_index,
                heading=row.heading,
                body=row.body,
                score=float(row.score),
            )
            for row in result.fetchall()
        ]

    async def vector_search(
        self,
        vault_ids: list[UUID],
        query_embedding: list[float],
        limit: int,
    ) -> list[ChunkScore]:
        """Return top-N rows by cosine similarity to ``query_embedding``."""
        dist_expr = SearchIndexEntry.embedding.cosine_distance(query_embedding)
        result = await self.session.execute(
            select(
                SearchIndexEntry.vault_id,
                SearchIndexEntry.path,
                SearchIndexEntry.chunk_index,
                SearchIndexEntry.heading,
                SearchIndexEntry.body,
                (1 - dist_expr).label("score"),
            )
            .where(
                SearchIndexEntry.vault_id.in_(vault_ids),
                SearchIndexEntry.embedding.isnot(None),
            )
            .order_by(dist_expr)
            .limit(limit)
        )
        return [
            ChunkScore(
                vault_id=row.vault_id,
                path=row.path,
                chunk_index=row.chunk_index,
                heading=row.heading,
                body=row.body,
                score=float(row.score),
            )
            for row in result.fetchall()
        ]
