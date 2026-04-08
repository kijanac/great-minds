"""One-shot script to rebuild search indexes for all brains.

Usage:
    DATABASE_URL=... OPENROUTER_API_KEY=... JWT_SECRET=... uv run python scripts/reindex.py
"""

import asyncio

from sqlalchemy import select

import great_minds.core.users.models  # noqa: F401
import great_minds.core.auth.models  # noqa: F401
import great_minds.core.brains.models  # noqa: F401
import great_minds.core.proposals.models  # noqa: F401
import great_minds.core.tasks  # noqa: F401
from great_minds.core.brains.models import BrainORM
from great_minds.core.brains._search_indexer import rebuild_index
from great_minds.core.db import session_maker
from great_minds.core.storage import LocalStorage


async def main() -> None:
    async with session_maker() as session:
        rows = await session.execute(select(BrainORM))
        brains = rows.scalars().all()

        if not brains:
            print("No brains found in database.")
            return

        print(f"Found {len(brains)} brain(s):\n")

        total = 0
        for brain in brains:
            print(f"  {brain.slug} ({brain.id})")
            storage = LocalStorage(brain.storage_root)

            wiki_files = storage.glob("wiki/*.md")
            article_count = len(
                [f for f in wiki_files if not f.rsplit("/", 1)[-1].startswith("_")]
            )

            if article_count == 0:
                print("    -> no wiki articles, skipping\n")
                continue

            print(f"    -> {article_count} wiki articles, indexing...")
            chunks = await rebuild_index(session, brain.id, storage)
            print(f"    -> {chunks} chunks indexed\n")
            total += chunks

        print(f"Done. {total} total chunks indexed across {len(brains)} brain(s).")


if __name__ == "__main__":
    asyncio.run(main())
