"""Test hybrid search directly against the index.

Usage:
    DATABASE_URL=... JWT_SECRET=... OPENROUTER_API_KEY=... uv run python scripts/test_search.py "your query here"
    DATABASE_URL=... JWT_SECRET=... OPENROUTER_API_KEY=... uv run python scripts/test_search.py  # runs all 3 demo queries
"""

import asyncio
import re
import sys

from sqlalchemy import select, func

import great_minds.core.users.models  # noqa: F401
import great_minds.core.auth.models  # noqa: F401
import great_minds.core.vaults.models  # noqa: F401
import great_minds.core.proposals.models  # noqa: F401
import great_minds.core.tasks  # noqa: F401
from great_minds.core.vaults.models import VaultORM
from great_minds.core.search import (
    search,
    SearchIndexEntry,
)
from great_minds.core.llm import (
    EMBEDDING_DIMENSIONS,
    EMBEDDING_MODEL,
    get_async_client,
    truncate_and_normalize,
)
from great_minds.core.settings import get_settings
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine


DEMO_QUERIES = [
    "What is Plekhanov's critique of Narodism?",
    "How do small farmers get absorbed into the capitalist system?",
    "What is the relationship between peasant differentiation and class consciousness?",
]


def _build_or_tsquery(query):
    words = [w for w in re.sub(r"[^\w\s]", "", query).split() if len(w) > 2]
    if not words:
        words = query.split()
    or_query = " | ".join(words)
    return func.to_tsquery("english", or_query)


async def run_bm25_only(session, vault_ids, query, limit=10):
    """Run BM25 search alone for comparison."""
    tsquery = _build_or_tsquery(query)
    result = await session.execute(
        select(
            SearchIndexEntry.path,
            SearchIndexEntry.heading,
            func.ts_rank(SearchIndexEntry.tsv, tsquery).label("rank"),
        )
        .where(
            SearchIndexEntry.vault_id.in_(vault_ids),
            SearchIndexEntry.tsv.bool_op("@@")(tsquery),
        )
        .order_by(func.ts_rank(SearchIndexEntry.tsv, tsquery).desc())
        .limit(limit)
    )
    return result.fetchall()


async def run_vector_only(session, vault_ids, query_embedding, limit=10):
    """Run vector search alone for comparison."""
    result = await session.execute(
        select(
            SearchIndexEntry.path,
            SearchIndexEntry.heading,
            (1 - SearchIndexEntry.embedding.cosine_distance(query_embedding)).label(
                "similarity"
            ),
        )
        .where(
            SearchIndexEntry.vault_id.in_(vault_ids),
            SearchIndexEntry.embedding.isnot(None),
        )
        .order_by(SearchIndexEntry.embedding.cosine_distance(query_embedding))
        .limit(limit)
    )
    return result.fetchall()


async def test_query(session, vault_ids, query):
    print(f"\n{'=' * 70}")
    print(f"QUERY: {query}")
    print("=" * 70)

    client = get_async_client()
    response = await client.embeddings.create(model=EMBEDDING_MODEL, input=[query])
    query_embedding = truncate_and_normalize(
        response.data[0].embedding, EMBEDDING_DIMENSIONS
    )

    # BM25 only
    bm25_rows = await run_bm25_only(session, vault_ids, query)
    print(f"\n--- BM25 results ({len(bm25_rows)}) ---")
    for i, row in enumerate(bm25_rows):
        slug = row.path.removeprefix("wiki/").removesuffix(".md")
        heading = f" > {row.heading}" if row.heading else ""
        print(f"  {i + 1:2d}. [{row.rank:.4f}] {slug}{heading}")

    # Vector only
    vector_rows = await run_vector_only(session, vault_ids, query_embedding)
    print(f"\n--- Vector results ({len(vector_rows)}) ---")
    for i, row in enumerate(vector_rows):
        slug = row.path.removeprefix("wiki/").removesuffix(".md")
        heading = f" > {row.heading}" if row.heading else ""
        print(f"  {i + 1:2d}. [{row.similarity:.4f}] {slug}{heading}")

    # Hybrid (RRF)
    hybrid_results = await search(session, vault_ids, query, limit=10)
    print(f"\n--- Hybrid RRF results ({len(hybrid_results)}) ---")
    for i, r in enumerate(hybrid_results):
        slug = r.path.removeprefix("wiki/").removesuffix(".md")
        heading = f" > {r.heading}" if r.heading else ""
        print(f"  {i + 1:2d}. [{r.score:.4f}] {slug}{heading}")


async def main():
    queries = [" ".join(sys.argv[1:])] if len(sys.argv) > 1 else DEMO_QUERIES

    settings = get_settings()
    engine = create_async_engine(settings.database_url)
    sm = async_sessionmaker(engine, expire_on_commit=False)

    async with sm() as session:
        rows = await session.execute(select(VaultORM))
        vaults = rows.scalars().all()
        vault_ids = [b.id for b in vaults]

        # Show index stats
        count = await session.execute(
            select(func.count()).select_from(SearchIndexEntry)
        )
        print(f"Index: {count.scalar()} chunks across {len(vaults)} vault(s)")

        for query in queries:
            await test_query(session, vault_ids, query)

    print()


if __name__ == "__main__":
    asyncio.run(main())
