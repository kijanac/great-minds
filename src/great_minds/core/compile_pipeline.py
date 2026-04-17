"""Six-phase compilation orchestrator.

Reads raw docs from a brain's storage, produces source cards (Phase 1),
distills them into a concept registry (Phase 2), and renders articles
to wiki/*.md (Phase 3). Phases 4–6 (cross-linking, index, lint) and
the archive flow are slotted in by later milestones.

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
from great_minds.core.subjects.distiller import (
    REFINE_CONCURRENCY,
    SIMILARITY_THRESHOLD,
    distill,
)
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
        await distill(
            client,
            brain_id=brain_id,
            threshold=similarity_threshold,
            refine_concurrency=refine_concurrency,
        )

    async with timed_op("render"):
        article_paths = await render_brain(
            client,
            brain_id=brain_id,
            raw_dir=raw_dir,
            wiki_dir=wiki_dir,
            concurrency=render_concurrency,
        )
    articles_written = [
        {"slug": path.stem, "action": "rendered"} for path in article_paths
    ]
    enrich(articles_written=len(articles_written))

    chunks_indexed = 0
    async with timed_op("rebuild_search_index"):
        chunks_indexed = await rebuild_index(session, brain_id, storage)
    enrich(chunks_indexed=chunks_indexed)

    log_event(
        "compile_completed",
        brain_id=str(brain_id),
        docs_compiled=docs_compiled,
        articles_written=len(articles_written),
        chunks_indexed=chunks_indexed,
    )
    return CompileResult(
        docs_compiled=docs_compiled,
        articles_written=articles_written,
        chunks_indexed=chunks_indexed,
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
