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

from great_minds.core.pipeline_runs import (
    PipelineProgressRunner,
    PipelineProgressStep,
    build_progress_steps,
)
from great_minds.core.search import SearchService
from great_minds.core.storage import Storage
from great_minds.core.telemetry import enrich, log_event

INGEST_STEP_LABELS = {
    "load_sources": "Loading sources",
    "prepare_text": "Preparing searchable text",
    "index_sources": "Indexing sources",
}


class IngestPhase:
    """Phase 0 runner with explicit dependencies.

    This follows the repo/service style used elsewhere: callers compose
    concrete dependencies up front, while phase logic no longer reaches
    through a broad context bag.
    """

    def __init__(
        self,
        *,
        storage: Storage,
        client: AsyncOpenAI,
        search: SearchService,
        progress: PipelineProgressRunner,
        pipeline_run_id: UUID,
    ) -> None:
        self.storage = storage
        self.client = client
        self.search = search
        self.progress = progress
        self.pipeline_run_id = pipeline_run_id

    def progress_steps(
        self,
        active: str,
        *,
        completed: set[str] | None = None,
        counts: dict[str, tuple[int | None, int | None]] | None = None,
    ) -> list[PipelineProgressStep]:
        return build_progress_steps(
            INGEST_STEP_LABELS,
            active,
            completed=completed,
            counts=counts,
        )

    async def run(self, vault_id: UUID) -> None:
        await self.progress.emit(
            pipeline_run_id=self.pipeline_run_id,
            phase="ingest",
            status="progress",
            steps=self.progress_steps("load_sources"),
        )
        await self.progress.emit(
            pipeline_run_id=self.pipeline_run_id,
            phase="ingest",
            status="progress",
            steps=self.progress_steps("prepare_text", completed={"load_sources"}),
        )
        await self.progress.emit(
            pipeline_run_id=self.pipeline_run_id,
            phase="ingest",
            status="progress",
            steps=self.progress_steps(
                "index_sources",
                completed={"load_sources", "prepare_text"},
            ),
        )
        count = await self.search.rebuild_raw_index(
            vault_id, self.storage, client=self.client
        )
        enrich(raw_chunks_indexed=count)
        log_event(
            "completed",
            raw_chunks_indexed=count,
        )
        await self.progress.emit(
            pipeline_run_id=self.pipeline_run_id,
            phase="ingest",
            status="completed",
            steps=self.progress_steps(
                "index_sources",
                completed=set(INGEST_STEP_LABELS),
            ),
        )
