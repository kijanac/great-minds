"""SearchIndexRepository — CRUD + ranking queries on search_index.

All SQL that touches SearchIndexEntry lives here. The service layer
calls these methods with already-built inputs (Chunk + embedding,
tokenized BM25 query string, query embedding vector) and never sees
a tsquery or cosine operator.
"""

import re
from collections import defaultdict
from uuid import UUID

from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.core.search.models import SearchIndexEntry
from great_minds.core.search.schemas import Chunk, ChunkHash, ChunkScore


class SearchIndexRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    # -- Rebuild / upsert path -------------------------------------------

    async def list_hashes_by_prefix(
        self, vault_id: UUID, path_prefix: str
    ) -> list[ChunkHash]:
        """Return (path, chunk_index, content_hash) rows for diff during rebuild."""
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
        return [ChunkHash.model_validate(r) for r in rows]

    async def delete_stale_in_scope(
        self,
        vault_id: UUID,
        path_prefix: str,
        current_keys: list[tuple[str, int]],
    ) -> int:
        """Delete rows under ``path_prefix`` absent from ``current_keys``.

        Avoid a huge composite ``NOT IN ((path, chunk), ...)`` expression:
        PostgreSQL can hit ``StatementTooComplexError`` for large vaults.
        Instead, delete missing paths once, then prune stale chunk indexes
        per remaining path.
        """
        scope_filter = (
            SearchIndexEntry.vault_id == vault_id,
            SearchIndexEntry.path.like(f"{path_prefix}%"),
        )
        if not current_keys:
            result = await self.session.execute(
                delete(SearchIndexEntry).where(*scope_filter)
            )
            return result.rowcount or 0

        chunks_by_path: dict[str, list[int]] = defaultdict(list)
        for path, chunk_index in current_keys:
            chunks_by_path[path].append(chunk_index)

        deleted = 0
        current_paths = list(chunks_by_path)
        result = await self.session.execute(
            delete(SearchIndexEntry).where(
                *scope_filter,
                SearchIndexEntry.path.not_in(current_paths),
            )
        )
        deleted += result.rowcount or 0

        for path, chunk_indexes in chunks_by_path.items():
            result = await self.session.execute(
                delete(SearchIndexEntry).where(
                    SearchIndexEntry.vault_id == vault_id,
                    SearchIndexEntry.path == path,
                    SearchIndexEntry.chunk_index.not_in(chunk_indexes),
                )
            )
            deleted += result.rowcount or 0

        return deleted

    async def batch_upsert(
        self,
        vault_id: UUID,
        chunks_and_embeddings: list[tuple[Chunk, list[float] | None]],
    ) -> None:
        """Upsert a batch of chunks with their embeddings in one INSERT.

        Avoids per-row SELECT + round-trip; uses ON CONFLICT to handle
        existing (vault_id, path, chunk_index) rows."""
        if not chunks_and_embeddings:
            return
        rows = []
        for chunk, emb in chunks_and_embeddings:
            rows.append(
                {
                    "vault_id": vault_id,
                    "path": chunk.path,
                    "chunk_index": chunk.chunk_index,
                    "heading": chunk.heading,
                    "body": chunk.body,
                    "content_hash": chunk.content_hash,
                    "tsv": func.to_tsvector("english", chunk.body),
                    "embedding": emb,
                    "updated_at": func.now(),
                }
            )
        stmt = insert(SearchIndexEntry).values(rows)
        stmt = stmt.on_conflict_do_update(
            index_elements=[
                SearchIndexEntry.vault_id,
                SearchIndexEntry.path,
                SearchIndexEntry.chunk_index,
            ],
            set_={
                "heading": stmt.excluded.heading,
                "body": stmt.excluded.body,
                "content_hash": stmt.excluded.content_hash,
                "tsv": stmt.excluded.tsv,
                "embedding": stmt.excluded.embedding,
                "updated_at": stmt.excluded.updated_at,
            },
        )
        await self.session.execute(stmt)

    # -- Context expansion ----------------------------------------------

    async def fetch_window(
        self,
        vault_ids: list[UUID],
        path: str,
        start_index: int,
        end_index: int,
    ) -> list[Chunk]:
        """Return body chunks for ``path`` in ``[start_index, end_index]``.

        Ordered by ``chunk_index``. Excludes the synthetic metadata chunk
        (``-1``): expansion is about reading body paragraphs in context,
        not the title/precis summary row. Bodies already live in the
        table, so this is a single indexed read with no storage round-trip.
        """
        rows = await self.session.execute(
            select(
                SearchIndexEntry.path,
                SearchIndexEntry.chunk_index,
                SearchIndexEntry.heading,
                SearchIndexEntry.body,
                SearchIndexEntry.content_hash,
            )
            .where(
                SearchIndexEntry.vault_id.in_(vault_ids),
                SearchIndexEntry.path == path,
                SearchIndexEntry.chunk_index >= max(0, start_index),
                SearchIndexEntry.chunk_index <= end_index,
            )
            .order_by(SearchIndexEntry.chunk_index)
        )
        return [Chunk.model_validate(row) for row in rows]

    async def list_outline(
        self, vault_ids: list[UUID], path: str
    ) -> list[tuple[int, str]]:
        """Return ``(chunk_index, heading)`` for ``path``'s body chunks.

        Ordered by ``chunk_index``, metadata chunk (``-1``) excluded.
        Headings-only (no bodies) so building a document outline is a
        light read even for long documents.
        """
        rows = await self.session.execute(
            select(SearchIndexEntry.chunk_index, SearchIndexEntry.heading)
            .where(
                SearchIndexEntry.vault_id.in_(vault_ids),
                SearchIndexEntry.path == path,
                SearchIndexEntry.chunk_index >= 0,
            )
            .order_by(SearchIndexEntry.chunk_index)
        )
        return [(idx, heading) for idx, heading in rows]

    # -- Diagnostics -----------------------------------------------------

    async def count_by_prefix(self, vault_id: UUID, path_prefix: str) -> int:
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
        self,
        vault_ids: list[UUID],
        query: str,
        limit: int,
        path: str | None = None,
    ) -> list[ChunkScore]:
        """Return top-N rows by ts_rank against a tokenized BM25 tsquery.

        Builds the tsquery internally — callers pass the raw user query
        string and this method tokenizes (strips non-word chars, drops
        words <=2 chars, OR-joins the rest via plainto_tsquery). When
        ``path`` is given, the search is scoped to that one document.
        """
        words = [w for w in re.sub(r"[^\w\s]", "", query).split() if len(w) > 2]
        if words:
            tsquery = func.plainto_tsquery("english", words[0])
            for w in words[1:]:
                tsquery = tsquery.bool_op("||")(func.plainto_tsquery("english", w))
        else:
            tsquery = func.plainto_tsquery("english", query)
        rank_expr = func.ts_rank(SearchIndexEntry.tsv, tsquery)
        stmt = select(
            SearchIndexEntry.vault_id,
            SearchIndexEntry.path,
            SearchIndexEntry.chunk_index,
            SearchIndexEntry.heading,
            SearchIndexEntry.body,
            rank_expr.label("score"),
        ).where(
            SearchIndexEntry.vault_id.in_(vault_ids),
            SearchIndexEntry.tsv.bool_op("@@")(tsquery),
        )
        if path is not None:
            stmt = stmt.where(SearchIndexEntry.path == path)
        stmt = stmt.order_by(rank_expr.desc()).limit(limit)
        result = await self.session.execute(stmt)
        return [ChunkScore.model_validate(row) for row in result.fetchall()]

    async def vector_search(
        self,
        vault_ids: list[UUID],
        query_embedding: list[float],
        limit: int,
        path: str | None = None,
    ) -> list[ChunkScore]:
        """Return top-N rows by cosine similarity to ``query_embedding``.

        When ``path`` is given, the search is scoped to that one document.
        """
        dist_expr = SearchIndexEntry.embedding.cosine_distance(query_embedding)
        stmt = select(
            SearchIndexEntry.vault_id,
            SearchIndexEntry.path,
            SearchIndexEntry.chunk_index,
            SearchIndexEntry.heading,
            SearchIndexEntry.body,
            (1 - dist_expr).label("score"),
        ).where(
            SearchIndexEntry.vault_id.in_(vault_ids),
            SearchIndexEntry.embedding.isnot(None),
        )
        if path is not None:
            stmt = stmt.where(SearchIndexEntry.path == path)
        stmt = stmt.order_by(dist_expr).limit(limit)
        result = await self.session.execute(stmt)
        return [ChunkScore.model_validate(row) for row in result.fetchall()]
