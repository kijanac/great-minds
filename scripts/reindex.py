"""One-shot script to rebuild search indexes for all vaults.

Usage:
    DATABASE_URL=... OPENROUTER_API_KEY=... JWT_SECRET=... uv run python scripts/reindex.py
"""

import asyncio
from uuid import uuid4

from sqlalchemy import select

import great_minds.core.users.models  # noqa: F401
import great_minds.core.auth.models  # noqa: F401
import great_minds.core.vaults.models  # noqa: F401
import great_minds.core.proposals.models  # noqa: F401
import great_minds.core.tasks  # noqa: F401
from great_minds.core.vaults.models import VaultORM
from great_minds.core.search import SearchIndexRepository, SearchService
from great_minds.core.settings import get_settings
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from great_minds.core.storage import LocalStorage


class _NoopProgress:
    async def emit(self, **kwargs) -> None:
        pass


_noop_progress = _NoopProgress()
_noop_run_id = uuid4()


async def main() -> None:
    settings = get_settings()
    engine = create_async_engine(settings.database_url)
    sm = async_sessionmaker(engine, expire_on_commit=False)
    async with sm() as session:
        rows = await session.execute(select(VaultORM))
        vaults = rows.scalars().all()

        if not vaults:
            print("No vaults found in database.")
            return

        print(f"Found {len(vaults)} vault(s):\n")

        total = 0
        for vault in vaults:
            print(f"  {vault.name} ({vault.id})")
            storage = LocalStorage(f"vaults/{vault.id}")

            raw_count = len(await storage.glob("raw/**/*.md"))
            wiki_count = len(
                [
                    f
                    for f in await storage.glob("wiki/*.md")
                    if not f.rsplit("/", 1)[-1].startswith("_")
                ]
            )

            if raw_count == 0 and wiki_count == 0:
                print("    -> no raw or wiki content, skipping\n")
                continue

            print(f"    -> {raw_count} raw docs, {wiki_count} wiki articles")
            svc = SearchService(SearchIndexRepository(session))
            raw_chunks = await svc.rebuild_raw_index(
                vault.id,
                storage,
                progress=_noop_progress,
                pipeline_run_id=_noop_run_id,
            )
            wiki_chunks = await svc.rebuild_wiki_index(
                vault.id,
                storage,
                progress=_noop_progress,
                pipeline_run_id=_noop_run_id,
            )
            print(
                f"    -> {raw_chunks} raw chunks + {wiki_chunks} wiki chunks indexed\n"
            )
            total += raw_chunks + wiki_chunks

        print(f"Done. {total} total chunks indexed across {len(vaults)} vault(s).")


if __name__ == "__main__":
    asyncio.run(main())
