"""Check for duplicate chunks in the search index."""

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
    async with sm() as s:
        # Check for duplicates by (vault_id, path, chunk_index)
        r = await s.execute(
            text("""
            SELECT vault_id, path, chunk_index, count(*) as n
            FROM search_index
            GROUP BY vault_id, path, chunk_index
            HAVING count(*) > 1
            ORDER BY n DESC
            LIMIT 10
        """)
        )
        dupes = r.fetchall()

        if dupes:
            print(f"Found {len(dupes)} duplicate groups:")
            for row in dupes:
                print(
                    f"  vault={row.vault_id}  path={row.path}  chunk={row.chunk_index}  count={row.n}"
                )
        else:
            print("No duplicate (vault_id, path, chunk_index) combinations found.")

        # Overall stats
        total = await s.execute(text("SELECT count(*) FROM search_index"))
        distinct = await s.execute(
            text(
                "SELECT count(DISTINCT (vault_id, path, chunk_index)) FROM search_index"
            )
        )
        print(f"\nTotal rows: {total.scalar()}")
        print(f"Distinct (vault, path, chunk): {distinct.scalar()}")

        # Check how many vaults have entries
        vaults = await s.execute(
            text("SELECT vault_id, count(*) FROM search_index GROUP BY vault_id")
        )
        for row in vaults:
            print(f"  vault {row.vault_id}: {row.count} chunks")


if __name__ == "__main__":
    asyncio.run(main())
