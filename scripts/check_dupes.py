"""Check for duplicate chunks in the search index."""

import asyncio

from sqlalchemy import text

import great_minds.core.users.models  # noqa: F401
import great_minds.core.auth.models  # noqa: F401
import great_minds.core.brains.models  # noqa: F401
import great_minds.core.proposals.models  # noqa: F401
import great_minds.core.tasks  # noqa: F401
from great_minds.core.db import session_maker


async def main():
    async with session_maker() as s:
        # Check for duplicates by (brain_id, path, chunk_index)
        r = await s.execute(
            text("""
            SELECT brain_id, path, chunk_index, count(*) as n
            FROM search_index
            GROUP BY brain_id, path, chunk_index
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
                    f"  brain={row.brain_id}  path={row.path}  chunk={row.chunk_index}  count={row.n}"
                )
        else:
            print("No duplicate (brain_id, path, chunk_index) combinations found.")

        # Overall stats
        total = await s.execute(text("SELECT count(*) FROM search_index"))
        distinct = await s.execute(
            text(
                "SELECT count(DISTINCT (brain_id, path, chunk_index)) FROM search_index"
            )
        )
        print(f"\nTotal rows: {total.scalar()}")
        print(f"Distinct (brain, path, chunk): {distinct.scalar()}")

        # Check how many brains have entries
        brains = await s.execute(
            text("SELECT brain_id, count(*) FROM search_index GROUP BY brain_id")
        )
        for row in brains:
            print(f"  brain {row.brain_id}: {row.count} chunks")


if __name__ == "__main__":
    asyncio.run(main())
