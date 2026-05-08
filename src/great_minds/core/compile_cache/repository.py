"""Repository for DB-backed compile cache entries."""

from uuid import UUID

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.core.compile_cache.models import CompileCacheEntryORM


class CompileCacheRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get(self, *, vault_id: UUID, phase: str, cache_key: str) -> dict | None:
        row = await self.session.execute(
            select(CompileCacheEntryORM).where(
                CompileCacheEntryORM.vault_id == vault_id,
                CompileCacheEntryORM.phase == phase,
                CompileCacheEntryORM.cache_key == cache_key,
            )
        )
        entry = row.scalar_one_or_none()
        if entry is None:
            return None
        return entry.value

    async def put(
        self, *, vault_id: UUID, phase: str, cache_key: str, value: dict
    ) -> None:
        await self.session.execute(
            insert(CompileCacheEntryORM)
            .values(
                vault_id=vault_id,
                phase=phase,
                cache_key=cache_key,
                value=value,
            )
            .on_conflict_do_nothing(index_elements=["vault_id", "phase", "cache_key"])
        )
