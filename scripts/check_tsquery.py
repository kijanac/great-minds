"""Debug why websearch_to_tsquery returns no matches."""

import asyncio

from sqlalchemy import text

import great_minds.core.users.models  # noqa: F401
import great_minds.core.auth.models  # noqa: F401
import great_minds.core.vaults.models  # noqa: F401
import great_minds.core.proposals.models  # noqa: F401
import great_minds.core.tasks  # noqa: F401
from great_minds.core.settings import get_settings
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine


async def main():
    settings = get_settings()
    engine = create_async_engine(settings.database_url)
    sm = async_sessionmaker(engine, expire_on_commit=False)
    async with sm() as session:
        queries = [
            "What is Plekhanov's critique of Narodism?",
            "Plekhanov",
            "peasant differentiation",
            "Narodism",
        ]
        for q in queries:
            # What does websearch_to_tsquery produce?
            result = await session.execute(
                text("SELECT websearch_to_tsquery('english', :q)::text"),
                {"q": q},
            )
            tsquery = result.scalar()

            # How many matches?
            count = await session.execute(
                text(
                    "SELECT count(*) FROM search_index WHERE tsv @@ websearch_to_tsquery('english', :q)"
                ),
                {"q": q},
            )
            n = count.scalar()
            print(f"  query: {q!r}")
            print(f"  tsquery: {tsquery}")
            print(f"  matches: {n}")
            print()


if __name__ == "__main__":
    asyncio.run(main())
