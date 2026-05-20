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

from great_minds.core.documents.service import SourceDocumentService
from great_minds.core.pipeline_runs import (
    PipelineProgressRunner,
    PipelineProgressStep,
    build_progress_steps,
)
from great_minds.core.search import SearchService
from great_minds.core.storage import Storage
from great_minds.core.telemetry import enrich, log_event

INGEST_STEP_LABELS = {
    "index_sources": "Indexing for search",
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
        source_docs: SourceDocumentService,
    ) -> None:
        self.storage = storage
        self.client = client
        self.search = search
        self.progress = progress
        self.pipeline_run_id = pipeline_run_id
        self.source_docs = source_docs

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
            steps=self.progress_steps("index_sources"),
        )

        # Load stored documents so we can compare ETags and skip
        # files whose R2 content hasn't changed since last index.
        docs = await self.source_docs.list_all(vault_id)
        stored_etags = {d.file_path: d.etag for d in docs}
        id_by_path = {d.file_path: d.id for d in docs}
        out_etags: list[tuple[str, str]] = []
        count = await self.search.rebuild_raw_index(
            vault_id,
            self.storage,
            client=self.client,
            stored_etags=stored_etags,
            out_etags=out_etags,
            progress=self.progress,
            pipeline_run_id=self.pipeline_run_id,
        )

        # Persist the current ETags so the next compile can skip unchanged
        # files without reading them from R2.
        if out_etags:
            await self.source_docs.refresh_etag_batch(
                [(id_by_path[p], e) for p, e in out_etags if p in id_by_path],
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
