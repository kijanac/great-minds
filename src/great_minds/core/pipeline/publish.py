"""Phase 6 — publish.

Mechanical. Writes two index files to storage (wiki/_index.md and
raw/_index.md) and appends a run summary to .compile/<brain_id>/log.md.

No LLM calls, no cache. Indexes rebuilt from current DB state each
compile. The wiki index is consumed by the agent's retrieval flow as
a cheap table of contents; the raw index does the same for primary
sources. The log is a human-readable timeline for understanding
registry drift between compiles.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from sqlalchemy import func, or_, select

from great_minds.core.brain_config import compile_root
from great_minds.core.documents.models import DocumentORM
from great_minds.core.documents.schemas import DocKind
from great_minds.core.pipeline.context import PipelineContext
from great_minds.core.search import SearchIndexEntry
from great_minds.core.telemetry import enrich, log_event
from great_minds.core.topics.models import TopicORM
from great_minds.core.topics.repository import TopicRepository
from great_minds.core.topics.schemas import ArticleStatus, Topic

log = logging.getLogger(__name__)

WIKI_INDEX_PATH = "wiki/_index.md"
RAW_INDEX_PATH = "raw/_index.md"


async def run(ctx: PipelineContext) -> None:
    rendered_topics = await TopicRepository(ctx.session).list_by_status(
        ctx.brain_id, ArticleStatus.RENDERED
    )
    raw_docs = await _load_raw_documents(ctx)

    _write_wiki_index(ctx, rendered_topics)
    _write_raw_index(ctx, raw_docs)

    counts = await _gather_log_counts(ctx)
    _append_compile_log(ctx, counts)

    enrich(
        publish_wiki_index_topics=len(rendered_topics),
        publish_raw_index_docs=len(raw_docs),
    )
    log_event(
        "pipeline.publish_completed",
        brain_id=str(ctx.brain_id),
        wiki_index_topics=len(rendered_topics),
        raw_index_docs=len(raw_docs),
        **counts,
    )


# ---------------------------------------------------------------------------
# Wiki index
# ---------------------------------------------------------------------------


def _write_wiki_index(ctx: PipelineContext, topics: list[Topic]) -> None:
    ordered = sorted(topics, key=lambda t: t.title.lower())
    lines = [
        "# Wiki Index",
        "",
        f"_{len(ordered)} rendered article{'s' if len(ordered) != 1 else ''}_",
        "",
    ]
    for t in ordered:
        description = (t.description or "").strip().replace("\n", " ")
        lines.append(f"- [{t.title}](wiki/{t.slug}.md) — {description}")
    lines.append("")
    ctx.storage.write(WIKI_INDEX_PATH, "\n".join(lines))


# ---------------------------------------------------------------------------
# Raw index
# ---------------------------------------------------------------------------


def _write_raw_index(ctx: PipelineContext, docs: list[DocumentORM]) -> None:
    ordered = sorted(docs, key=lambda d: d.title.lower())
    lines = [
        "# Raw Sources",
        "",
        f"_{len(ordered)} document{'s' if len(ordered) != 1 else ''}_",
        "",
    ]
    for d in ordered:
        meta_bits: list[str] = []
        if d.genre:
            meta_bits.append(d.genre)
        if d.published_date:
            meta_bits.append(d.published_date)
        if d.author:
            meta_bits.append(d.author)
        meta_suffix = f" — {', '.join(meta_bits)}" if meta_bits else ""
        precis = (d.precis or "").strip().replace("\n", " ")
        precis_suffix = f"  \n  {precis}" if precis else ""
        lines.append(f"- [{d.title}]({d.file_path}){meta_suffix}{precis_suffix}")
    lines.append("")
    ctx.storage.write(RAW_INDEX_PATH, "\n".join(lines))


# ---------------------------------------------------------------------------
# Compile log
# ---------------------------------------------------------------------------


async def _gather_log_counts(ctx: PipelineContext) -> dict:
    topics_total = await ctx.session.scalar(
        select(func.count())
        .select_from(TopicORM)
        .where(TopicORM.brain_id == ctx.brain_id)
    )
    rendered = await ctx.session.scalar(
        select(func.count())
        .select_from(TopicORM)
        .where(
            TopicORM.brain_id == ctx.brain_id,
            TopicORM.article_status == ArticleStatus.RENDERED.value,
        )
    )
    archived = await ctx.session.scalar(
        select(func.count())
        .select_from(TopicORM)
        .where(
            TopicORM.brain_id == ctx.brain_id,
            TopicORM.article_status == ArticleStatus.ARCHIVED.value,
        )
    )
    dirty = await ctx.session.scalar(
        select(func.count())
        .select_from(TopicORM)
        .where(
            TopicORM.brain_id == ctx.brain_id,
            TopicORM.article_status != ArticleStatus.ARCHIVED.value,
            TopicORM.compiled_from_hash.is_not(None),
            or_(
                TopicORM.rendered_from_hash.is_(None),
                TopicORM.rendered_from_hash != TopicORM.compiled_from_hash,
            ),
        )
    )
    docs_total = await ctx.session.scalar(
        select(func.count())
        .select_from(DocumentORM)
        .where(
            DocumentORM.brain_id == ctx.brain_id,
            DocumentORM.doc_kind == DocKind.RAW.value,
        )
    )
    chunks_raw = await ctx.session.scalar(
        select(func.count())
        .select_from(SearchIndexEntry)
        .where(
            SearchIndexEntry.brain_id == ctx.brain_id,
            SearchIndexEntry.path.like("raw/%"),
        )
    )
    chunks_wiki = await ctx.session.scalar(
        select(func.count())
        .select_from(SearchIndexEntry)
        .where(
            SearchIndexEntry.brain_id == ctx.brain_id,
            SearchIndexEntry.path.like("wiki/%"),
        )
    )
    return {
        "topics_total": topics_total or 0,
        "topics_rendered": rendered or 0,
        "topics_archived": archived or 0,
        "topics_dirty": dirty or 0,
        "docs_raw": docs_total or 0,
        "chunks_raw": chunks_raw or 0,
        "chunks_wiki": chunks_wiki or 0,
    }


def _append_compile_log(ctx: PipelineContext, counts: dict) -> None:
    log_path = compile_root(ctx.brain_id) / "log.md"
    log_path.parent.mkdir(parents=True, exist_ok=True)

    ts = datetime.now(timezone.utc).isoformat(timespec="seconds")
    lines = [
        f"## {ts}",
        f"- topics: {counts['topics_total']} "
        f"(rendered {counts['topics_rendered']}, "
        f"archived {counts['topics_archived']}, "
        f"dirty {counts['topics_dirty']})",
        f"- raw docs: {counts['docs_raw']}",
        f"- chunks: {counts['chunks_raw']} raw + {counts['chunks_wiki']} wiki",
        "",
    ]

    existing = log_path.read_text(encoding="utf-8") if log_path.exists() else ""
    log_path.write_text(existing + "\n".join(lines) + "\n", encoding="utf-8")


# ---------------------------------------------------------------------------
# Loaders
# ---------------------------------------------------------------------------


async def _load_raw_documents(ctx: PipelineContext) -> list[DocumentORM]:
    rows = (
        await ctx.session.execute(
            select(DocumentORM).where(
                DocumentORM.brain_id == ctx.brain_id,
                DocumentORM.doc_kind == DocKind.RAW.value,
            )
        )
    ).scalars().all()
    return list(rows)
