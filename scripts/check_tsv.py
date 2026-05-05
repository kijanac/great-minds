"""Check tsvector state in the search index."""

import asyncio

from sqlalchemy import select, func, text

import great_minds.core.users.models  # noqa: F401
import great_minds.core.auth.models  # noqa: F401
import great_minds.core.vaults.models  # noqa: F401
import great_minds.core.proposals.models  # noqa: F401
import great_minds.core.tasks  # noqa: F401
from great_minds.core.search import SearchIndexEntry
from great_minds.core.settings import get_settings
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine


async def main():
    settings = get_settings()
    engine = create_async_engine(settings.database_url)
    sm = async_sessionmaker(engine, expire_on_commit=False)
    async with sm() as session:
        # Check if tsv column has data
        result = await session.execute(
            select(
                func.count().label("total"),
                func.count(SearchIndexEntry.tsv).label("with_tsv"),
            )
        )
        row = result.one()
        print(f"Total rows: {row.total}, with tsv: {row.with_tsv}")

        # Sample a tsvector value
        sample = await session.execute(
            select(
                SearchIndexEntry.path, SearchIndexEntry.tsv, SearchIndexEntry.body
            ).limit(1)
        )
        s = sample.one()
        print(f"\nSample path: {s.path}")
        print(f"Sample tsv:  {str(s.tsv)[:200]}")
        print(f"Sample body: {s.body[:100]}")

        # Test a direct tsquery
        test = await session.execute(
            text(
                "SELECT count(*) FROM search_index WHERE tsv @@ websearch_to_tsquery('english', 'Plekhanov')"
            )
        )
        print(f"\nMatches for 'Plekhanov': {test.scalar()}")

        test2 = await session.execute(
            text(
                "SELECT count(*) FROM search_index WHERE tsv @@ to_tsquery('english', 'peasant')"
            )
        )
        print(f"Matches for 'peasant': {test2.scalar()}")

        # Check if tsv is actually populated or just empty
        empty = await session.execute(
            text("SELECT count(*) FROM search_index WHERE tsv = ''::tsvector")
        )
        print(f"Rows with empty tsv: {empty.scalar()}")


if __name__ == "__main__":
    asyncio.run(main())
