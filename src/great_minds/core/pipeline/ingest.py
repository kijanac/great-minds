"""Phase 0 — ingest.

Walks the vault's raw/ tree, chunks each markdown file by heading,
embeds changed chunks, and upserts into the search_index table. Purely
mechanical — no LLM calls beyond the embedding model. Gives the agent
RAG access to primary sources.

Wiki re-chunking lives in phase 4 (render), which calls rebuild_wiki_index
after writing articles.
"""

from uuid import UUID

from openai import AsyncOpenAI

from great_minds.core.search import SearchService
from great_minds.core.storage import Storage
from great_minds.core.telemetry import enrich, log_event


class IngestPhase:
    """Phase 0 runner with explicit dependencies.

    This follows the repo/service style used elsewhere: callers compose
    concrete dependencies up front, while phase logic no longer reaches
    through the broad ``PipelineContext`` bag.
    """

    def __init__(
        self,
        *,
        storage: Storage,
        client: AsyncOpenAI,
        search: SearchService,
    ) -> None:
        self.storage = storage
        self.client = client
        self.search = search

    async def run(self, vault_id: UUID) -> None:
        count = await self.search.rebuild_raw_index(
            vault_id, self.storage, client=self.client
        )
        enrich(raw_chunks_indexed=count)
        log_event(
            "pipeline.ingest_completed",
            vault_id=str(vault_id),
            raw_chunks_indexed=count,
        )
