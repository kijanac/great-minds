"""Phase 0 — ingest.

Walks the brain's raw/ tree, chunks each markdown file by heading,
embeds changed chunks, and upserts into the search_index table. Purely
mechanical — no LLM calls beyond the embedding model. Gives the agent
RAG access to primary sources.

Wiki re-chunking lives in phase 4 (render), which calls rebuild_wiki_index
after writing articles.
"""

from __future__ import annotations

from great_minds.core.pipeline.context import PipelineContext
from great_minds.core.search import rebuild_raw_index
from great_minds.core.telemetry import enrich, log_event


async def run(ctx: PipelineContext) -> None:
    count = await rebuild_raw_index(
        ctx.session, ctx.brain_id, ctx.storage, client=ctx.client
    )
    enrich(raw_chunks_indexed=count)
    log_event(
        "pipeline.ingest_completed",
        brain_id=str(ctx.brain_id),
        raw_chunks_indexed=count,
    )
