"""Six-phase compilation orchestrator.

Reads raw docs from a brain's storage, produces source cards (Phase 1),
distills them into a concept registry (Phase 2), archives retired
articles so session links still resolve (archive sub-phase, between 2
and 3), renders live articles (Phase 3), cross-links the wiki +
refreshes backlinks (Phase 4), and assembles the mechanical index + run
log (Phase 5). Phase 6 (lint) is a detection-only report served on
demand via GET /lint — it is not a stage of the compile pipeline.

Entry point:
    from great_minds.core.compile_pipeline import run
    result = await run(storage, brain_id=..., session=..., limit=...)

The return shape matches what callers (workers, CLI) expect so that
the compile task API stays stable while the pipeline body is rewritten.
"""

import asyncio
import logging
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.core.llm import get_async_client
from great_minds.core.search import rebuild_index
from great_minds.core.storage import Storage
from great_minds.core.subjects.archive import archive_retired_concepts
from great_minds.core.subjects.concept_repository import mark_rendered
from great_minds.core.subjects.crosslinker import crosslink_wiki
from great_minds.core.subjects.distiller import (
    REFINE_CONCURRENCY,
    SIMILARITY_THRESHOLD,
    distill,
)
from great_minds.core.subjects.indexer import append_log, write_index
from great_minds.core.subjects.renderer import render_brain
from great_minds.core.subjects.service import (
    ExtractionResult,
    extract_from_file,
    write_source_card,
)
from great_minds.core.telemetry import enrich, log_event, timed_op

log = logging.getLogger(__name__)

DEFAULT_EXTRACT_CONCURRENCY = 20
DEFAULT_RENDER_CONCURRENCY = 10


@dataclass
class CompileResult:
    """Summary of a compile run, surfaced back to the task/CLI caller."""

    docs_compiled: int = 0
    articles_written: list[dict] = field(default_factory=list)
    chunks_indexed: int = 0
    archived: list[dict] = field(default_factory=list)


async def run(
    storage: Storage,
    *,
    brain_id: uuid.UUID,
    session: AsyncSession,
    limit: int | None = None,
    extract_concurrency: int = DEFAULT_EXTRACT_CONCURRENCY,
    refine_concurrency: int = REFINE_CONCURRENCY,
    render_concurrency: int = DEFAULT_RENDER_CONCURRENCY,
    similarity_threshold: float = SIMILARITY_THRESHOLD,
) -> CompileResult:
    """Run extract → distill → render → rebuild-search end to end.

    storage must expose a `.root` attribute — the orchestrator walks
    storage.root / "raw" for source docs and writes to
    storage.root / "wiki" for rendered articles. The LocalStorage
    implementation satisfies this; a future remote-storage backend
    would need an equivalent path.
    """
    root = Path(getattr(storage, "root"))
    raw_dir = root / "raw"
    wiki_dir = root / "wiki"

    if not raw_dir.exists():
        log.warning("no raw/ directory at %s; skipping compile", raw_dir)
        return CompileResult()

    client = get_async_client()

    async with timed_op("extract"):
        docs_compiled = await _extract_phase(
            client,
            brain_id=brain_id,
            raw_dir=raw_dir,
            limit=limit,
            concurrency=extract_concurrency,
        )
    enrich(docs_compiled=docs_compiled)

    async with timed_op("distill"):
        distillation = await distill(
            client,
            brain_id=brain_id,
            threshold=similarity_threshold,
            refine_concurrency=refine_concurrency,
        )

    concepts = distillation.concepts

    async with timed_op("archive"):
        archive_entries = await archive_retired_concepts(
            session=session,
            brain_id=brain_id,
            live_concepts=concepts,
            wiki_dir=wiki_dir,
        )
    enrich(archived=len(archive_entries))

    async with timed_op("render"):
        rendered = await render_brain(
            client,
            brain_id=brain_id,
            raw_dir=raw_dir,
            wiki_dir=wiki_dir,
            concurrency=render_concurrency,
        )
    if rendered:
        await mark_rendered(
            session,
            brain_id,
            {c.concept_id: c.compiled_from_hash for c, _ in rendered},
        )
    articles_written = [
        {"slug": concept.slug, "action": "rendered"} for concept, _ in rendered
    ]
    enrich(articles_written=len(articles_written))

    async with timed_op("crosslink"):
        await crosslink_wiki(
            wiki_dir=wiki_dir,
            concepts=concepts,
            session=session,
            brain_id=brain_id,
        )

    async with timed_op("index"):
        write_index(wiki_dir=wiki_dir, concepts=concepts)

    chunks_indexed = 0
    async with timed_op("rebuild_search_index"):
        chunks_indexed = await rebuild_index(session, brain_id, storage)
    enrich(chunks_indexed=chunks_indexed)

    append_log(
        compile_dir=Path(".compile") / str(brain_id),
        brain_id=brain_id,
        added=distillation.added,
        dirty=distillation.dirty,
        retired=distillation.retired,
        articles_rendered=len(articles_written),
        chunks_indexed=chunks_indexed,
    )

    archived_summary = [
        {
            "concept_id": str(e.concept_id),
            "old_slug": e.old_slug,
            "superseded_by": e.superseded_by_slug,
        }
        for e in archive_entries
    ]

    log_event(
        "compile_completed",
        brain_id=str(brain_id),
        docs_compiled=docs_compiled,
        concepts_added=len(distillation.added),
        concepts_dirty=len(distillation.dirty),
        concepts_unchanged=len(distillation.unchanged),
        retired=len(distillation.retired),
        articles_written=len(articles_written),
        chunks_indexed=chunks_indexed,
        archived=len(archived_summary),
    )
    return CompileResult(
        docs_compiled=docs_compiled,
        articles_written=articles_written,
        chunks_indexed=chunks_indexed,
        archived=archived_summary,
    )


async def _extract_phase(
    client,
    *,
    brain_id: uuid.UUID,
    raw_dir: Path,
    limit: int | None,
    concurrency: int,
) -> int:
    """Extract source cards for every raw doc; write them serially.

    Re-extraction on each run is wasteful; dirty-flagging based on
    document hash + extraction_version is planned for a later milestone.
    """
    files = sorted(raw_dir.rglob("*.md"))
    if limit is not None:
        files = files[:limit]
    if not files:
        return 0

    sem = asyncio.Semaphore(concurrency)

    async def _one(fp: Path) -> tuple[Path, ExtractionResult | Exception]:
        async with sem:
            try:
                result = await extract_from_file(
                    client,
                    brain_id=brain_id,
                    file_path=fp,
                    write_card=False,
                )
                return fp, result
            except Exception as exc:
                log_event(
                    "extract_failed",
                    level=40,
                    brain_id=str(brain_id),
                    file=fp.as_posix(),
                    error=repr(exc)[:300],
                )
                return fp, exc

    outcomes = await asyncio.gather(*(_one(fp) for fp in files))

    written = 0
    for _, outcome in outcomes:
        if isinstance(outcome, ExtractionResult):
            write_source_card(brain_id=brain_id, card=outcome.source_card)
            written += 1
    return written
