"""Phase 6 — publish.

Mechanical. Writes two index files to storage (wiki/_index.md and
raw/_index.md) and appends a run summary to .compile/<vault_id>/log.md.

No LLM calls, no cache. Indexes rebuilt from current DB state each
compile. The wiki index is consumed by the agent's retrieval flow as
a cheap table of contents; the raw index does the same for primary
sources. The log is a human-readable timeline for understanding
registry drift between compiles.
"""

import logging
from datetime import datetime, timezone
from pathlib import Path
from uuid import UUID

from pydantic import BaseModel

from great_minds.core.documents import DocKind, Document, DocumentService
from great_minds.core.paths import (
    RAW_INDEX_PATH,
    RAW_PREFIX,
    WIKI_INDEX_PATH,
    WIKI_PREFIX,
    compile_log_path,
    wiki_path,
)
from great_minds.core.pipeline_runs import (
    PipelineProgressRunner,
    PipelineProgressStep,
    build_progress_steps,
)
from great_minds.core.search import SearchService
from great_minds.core.storage import Storage
from great_minds.core.telemetry import enrich, log_event
from great_minds.core.topics.schemas import ArticleStatus, Topic
from great_minds.core.topics.service import TopicService

log = logging.getLogger(__name__)

PUBLISH_STEP_LABELS = {
    "prepare_snapshot": "Preparing published snapshot",
    "publish_wiki": "Publishing wiki",
    "finalize_compile": "Finalizing compile",
}


class CompileLogCounts(BaseModel):
    """Counts rolled up at publish time for the compile log.md artifact."""

    topics_total: int
    topics_rendered: int
    topics_archived: int
    topics_dirty: int
    docs_raw: int
    chunks_raw: int
    chunks_wiki: int


class PublishPhase:
    """Phase 6 runner with explicit service-style dependencies."""

    def __init__(
        self,
        *,
        storage: Storage,
        sidecar_root: Path,
        topics: TopicService,
        documents: DocumentService,
        search: SearchService,
        progress: PipelineProgressRunner,
        pipeline_run_id: UUID,
    ) -> None:
        self.storage = storage
        self.sidecar_root = sidecar_root
        self.topics = topics
        self.documents = documents
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
            PUBLISH_STEP_LABELS,
            active,
            completed=completed,
            counts=counts,
        )

    async def run(self, vault_id: UUID) -> None:
        await self.progress.emit(
            pipeline_run_id=self.pipeline_run_id,
            phase="publish",
            status="progress",
            steps=self.progress_steps("prepare_snapshot"),
        )
        rendered_topics = await self.topics.list_for_vault(
            vault_id, ArticleStatus.RENDERED
        )
        raw_docs = await self.documents.list_by_kind(vault_id, DocKind.RAW)

        await self.progress.emit(
            pipeline_run_id=self.pipeline_run_id,
            phase="publish",
            status="progress",
            steps=self.progress_steps(
                "publish_wiki",
                completed={"prepare_snapshot"},
                counts={"publish_wiki": (0, 2)},
            ),
        )
        await self._write_wiki_index(rendered_topics)
        await self.progress.emit(
            pipeline_run_id=self.pipeline_run_id,
            phase="publish",
            status="progress",
            steps=self.progress_steps(
                "publish_wiki",
                completed={"prepare_snapshot"},
                counts={"publish_wiki": (1, 2)},
            ),
        )
        await self._write_raw_index(raw_docs)

        await self.progress.emit(
            pipeline_run_id=self.pipeline_run_id,
            phase="publish",
            status="progress",
            steps=self.progress_steps(
                "finalize_compile",
                completed={"prepare_snapshot", "publish_wiki"},
                counts={"publish_wiki": (2, 2)},
            ),
        )
        counts = await self._gather_log_counts(vault_id)
        self._append_compile_log(counts)

        enrich(
            publish_wiki_index_topics=len(rendered_topics),
            publish_raw_index_docs=len(raw_docs),
        )
        log_event(
            "completed",
            wiki_index_topics=len(rendered_topics),
            raw_index_docs=len(raw_docs),
            **counts.model_dump(),
        )
        await self.progress.emit(
            pipeline_run_id=self.pipeline_run_id,
            phase="publish",
            status="completed",
            steps=self.progress_steps(
                "finalize_compile",
                completed=set(PUBLISH_STEP_LABELS),
                counts={"publish_wiki": (2, 2)},
            ),
        )

    # ---------------------------------------------------------------------------
    # Wiki index
    # ---------------------------------------------------------------------------

    async def _write_wiki_index(self, topics: list[Topic]) -> None:
        ordered = sorted(topics, key=lambda t: t.title.lower())
        lines = [
            "# Wiki Index",
            "",
            f"_{len(ordered)} rendered article{'s' if len(ordered) != 1 else ''}_",
            "",
        ]
        for t in ordered:
            description = t.description.strip().replace("\n", " ")
            lines.append(f"- [{t.title}]({wiki_path(t.slug)}) — {description}")
        lines.append("")
        await self.storage.write(WIKI_INDEX_PATH, "\n".join(lines))

    # ---------------------------------------------------------------------------
    # Raw index
    # ---------------------------------------------------------------------------

    async def _write_raw_index(self, docs: list[Document]) -> None:
        ordered = sorted(docs, key=lambda d: d.metadata.title.lower())
        lines = [
            "# Raw Sources",
            "",
            f"_{len(ordered)} document{'s' if len(ordered) != 1 else ''}_",
            "",
        ]
        for d in ordered:
            metadata = d.metadata
            meta_bits: list[str] = []
            if metadata.genre:
                meta_bits.append(metadata.genre)
            if metadata.published_date:
                meta_bits.append(metadata.published_date)
            if metadata.author:
                meta_bits.append(metadata.author)
            meta_suffix = f" — {', '.join(meta_bits)}" if meta_bits else ""
            precis = (metadata.precis or "").strip().replace("\n", " ")
            precis_suffix = f"  \n  {precis}" if precis else ""
            lines.append(
                f"- [{metadata.title}]({d.file_path}){meta_suffix}{precis_suffix}"
            )
        lines.append("")
        await self.storage.write(RAW_INDEX_PATH, "\n".join(lines))

    # ---------------------------------------------------------------------------
    # Compile log
    # ---------------------------------------------------------------------------

    async def _gather_log_counts(self, vault_id: UUID) -> CompileLogCounts:
        return CompileLogCounts(
            topics_total=await self.topics.count_for_vault(vault_id),
            topics_rendered=await self.topics.count_for_vault(
                vault_id, ArticleStatus.RENDERED
            ),
            topics_archived=await self.topics.count_for_vault(
                vault_id, ArticleStatus.ARCHIVED
            ),
            topics_dirty=await self.topics.count_dirty(vault_id),
            docs_raw=await self.documents.count_by_kind(vault_id, DocKind.RAW),
            chunks_raw=await self.search.count_by_prefix(vault_id, RAW_PREFIX),
            chunks_wiki=await self.search.count_by_prefix(vault_id, WIKI_PREFIX),
        )

    def _append_compile_log(self, counts: CompileLogCounts) -> None:
        log_path = compile_log_path(self.sidecar_root)
        log_path.parent.mkdir(parents=True, exist_ok=True)

        ts = datetime.now(timezone.utc).isoformat(timespec="seconds")
        lines = [
            f"## {ts}",
            f"- topics: {counts.topics_total} "
            f"(rendered {counts.topics_rendered}, "
            f"archived {counts.topics_archived}, "
            f"dirty {counts.topics_dirty})",
            f"- raw docs: {counts.docs_raw}",
            f"- chunks: {counts.chunks_raw} raw + {counts.chunks_wiki} wiki",
            "",
        ]

        existing = log_path.read_text(encoding="utf-8") if log_path.exists() else ""
        log_path.write_text(existing + "\n".join(lines) + "\n", encoding="utf-8")
