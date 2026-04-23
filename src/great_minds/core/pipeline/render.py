"""Phase 4 — render.

One LLM call per canonical topic. Input is the topic (title,
description, subsumed ideas with their anchors, link_targets); output
is a markdown article body. The LLM uses pre-numbered `[^N]` footnote
markers in prose; the system post-processes: drops orphan markers,
renumbers contiguously by first appearance, appends the footnote
resolution section from known anchor metadata. Frontmatter is added
mechanically at write time — the LLM never sees or emits it.

Cache key includes topic_id + content hash + sorted link_targets +
prompt hash + RENDER_MODEL. Cache hit + existing wiki file on disk
means skip; either missing means re-render (heals deleted files).

Per-topic failures (LLM error, invalid body shape) log + skip. The
next compile retries the failed topics naturally via the same cache
key. No LLM fallback — a render flake surfaces via missing article,
not degraded content.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import re
from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import select

from great_minds.core.brain import load_prompt
from great_minds.core.brain_utils import (
    api_call,
    extract_content,
    serialize_frontmatter,
)
from great_minds.core.documents.models import DocumentORM
from great_minds.core.ideas.schemas import Anchor, Idea, SourceCard
from great_minds.core.ideas.source_cards import SourceCardStore
from great_minds.core.llm import RENDER_MODEL
from great_minds.core.pipeline.abstract.schemas import ValidatedCanonicalTopic
from great_minds.core.pipeline.context import PipelineContext
from great_minds.core.search import rebuild_wiki_index
from great_minds.core.settings import get_settings
from great_minds.core.telemetry import enrich, log_event
from great_minds.core.topics.repository import TopicRepository

log = logging.getLogger(__name__)

PHASE = "render"
_FOOTNOTE_RE = re.compile(r"\[\^(\d+)\]")
_HEADING_RE = re.compile(r"^# ", re.MULTILINE)


@dataclass
class RenderResult:
    topics_rendered: int = 0
    cache_hits: int = 0
    cache_misses: int = 0
    topics_failed: int = 0
    wiki_chunks_indexed: int = 0


async def run(
    ctx: PipelineContext,
    validated: list[ValidatedCanonicalTopic],
) -> RenderResult:
    if not validated:
        log_event(
            "pipeline.render_skipped",
            brain_id=str(ctx.brain_id),
            reason="no_topics",
        )
        return RenderResult()

    source_cards = SourceCardStore.for_brain(ctx.brain_id).load_all()
    idea_by_id = _index_ideas(source_cards)
    doc_by_id = await _load_documents(ctx.session, ctx.brain_id)
    topic_by_slug = {v.slug: v for v in validated}

    prompt_template = load_prompt(ctx.storage, "render")
    prompt_hash = hashlib.sha256(prompt_template.encode()).hexdigest()

    settings = get_settings()
    sem = asyncio.Semaphore(settings.compile_write_concurrency)

    tasks = [
        _render_one(
            ctx=ctx,
            sem=sem,
            topic=v,
            idea_by_id=idea_by_id,
            doc_by_id=doc_by_id,
            topic_by_slug=topic_by_slug,
            prompt_template=prompt_template,
            prompt_hash=prompt_hash,
        )
        for v in validated
    ]
    outcomes = await asyncio.gather(*tasks)

    repo = TopicRepository(ctx.session)
    result = RenderResult()
    any_rendered = False
    for outcome in outcomes:
        if outcome.error is not None:
            result.topics_failed += 1
            continue
        result.topics_rendered += 1
        if outcome.cache_hit:
            result.cache_hits += 1
        else:
            result.cache_misses += 1
            await repo.set_rendered(
                outcome.topic_id,
                rendered_from_hash=outcome.rendered_from_hash,
            )
            any_rendered = True

    await ctx.session.commit()

    if any_rendered:
        result.wiki_chunks_indexed = await rebuild_wiki_index(
            ctx.session, ctx.brain_id, ctx.storage, client=ctx.client
        )

    enrich(
        render_topics_rendered=result.topics_rendered,
        render_cache_hits=result.cache_hits,
        render_cache_misses=result.cache_misses,
        render_topics_failed=result.topics_failed,
        render_wiki_chunks_indexed=result.wiki_chunks_indexed,
    )
    log_event(
        "pipeline.render_completed",
        brain_id=str(ctx.brain_id),
        topics_rendered=result.topics_rendered,
        cache_hits=result.cache_hits,
        cache_misses=result.cache_misses,
        topics_failed=result.topics_failed,
        wiki_chunks_indexed=result.wiki_chunks_indexed,
    )
    return result


# ---------------------------------------------------------------------------
# Per-topic render
# ---------------------------------------------------------------------------


@dataclass
class _RenderOutcome:
    topic_id: UUID
    cache_hit: bool = False
    error: str | None = None
    rendered_from_hash: str = ""


async def _render_one(
    *,
    ctx: PipelineContext,
    sem: asyncio.Semaphore,
    topic: ValidatedCanonicalTopic,
    idea_by_id: dict[UUID, tuple[Idea, SourceCard]],
    doc_by_id: dict[UUID, DocumentORM],
    topic_by_slug: dict[str, ValidatedCanonicalTopic],
    prompt_template: str,
    prompt_hash: str,
) -> _RenderOutcome:
    outcome = _RenderOutcome(topic_id=topic.topic_id)
    wiki_path = f"wiki/{topic.slug}.md"

    numbered_anchors = _build_numbered_anchors(topic, idea_by_id, doc_by_id)
    compiled_from_hash = _topic_content_hash(topic)
    cache_key = _cache_key(
        topic_id=topic.topic_id,
        compiled_from_hash=compiled_from_hash,
        link_targets=topic.link_targets,
        prompt_hash=prompt_hash,
    )

    cached = ctx.cache.get(PHASE, cache_key)
    if cached is not None and ctx.storage.exists(wiki_path):
        outcome.cache_hit = True
        outcome.rendered_from_hash = compiled_from_hash
        return outcome

    idea_block = _render_idea_block(
        topic=topic,
        numbered_anchors=numbered_anchors,
        idea_by_id=idea_by_id,
        doc_by_id=doc_by_id,
    )
    link_targets_block = _render_link_targets_block(
        topic.link_targets, topic_by_slug
    )
    prompt = (
        prompt_template.replace("{title}", topic.title)
        .replace("{description}", topic.description)
        .replace("{idea_block}", idea_block)
        .replace("{link_targets_block}", link_targets_block or "(none)")
    )

    try:
        async with sem:
            response = await api_call(
                ctx.client,
                model=RENDER_MODEL,
                messages=[{"role": "user", "content": prompt}],
                temperature=0.3,
            )
            raw_body = extract_content(response) or ""
    except Exception as e:
        outcome.error = f"llm_call:{repr(e)[:200]}"
        log_event(
            "render.topic_failed",
            level=logging.WARNING,
            brain_id=str(ctx.brain_id),
            topic_slug=topic.slug,
            error=outcome.error,
        )
        return outcome

    try:
        body = _validate_and_postprocess(raw_body, numbered_anchors)
    except ValueError as e:
        outcome.error = f"body_invalid:{str(e)[:200]}"
        log_event(
            "render.body_invalid",
            level=logging.WARNING,
            brain_id=str(ctx.brain_id),
            topic_slug=topic.slug,
            error=outcome.error,
            body_preview=raw_body[:300],
        )
        return outcome

    fm = {
        "topic_id": str(topic.topic_id),
        "title": topic.title,
        "description": topic.description,
    }
    ctx.storage.write(wiki_path, serialize_frontmatter(fm, body))
    ctx.cache.put(PHASE, cache_key, {"body": body})
    outcome.rendered_from_hash = compiled_from_hash
    return outcome


# ---------------------------------------------------------------------------
# Anchor numbering + rendering
# ---------------------------------------------------------------------------


@dataclass
class _NumberedAnchor:
    number: int
    anchor: Anchor
    idea: Idea
    doc: DocumentORM | None


def _build_numbered_anchors(
    topic: ValidatedCanonicalTopic,
    idea_by_id: dict[UUID, tuple[Idea, SourceCard]],
    doc_by_id: dict[UUID, DocumentORM],
) -> list[_NumberedAnchor]:
    out: list[_NumberedAnchor] = []
    counter = 0
    for idea_id in topic.subsumed_idea_ids:
        item = idea_by_id.get(idea_id)
        if item is None:
            continue
        idea, _ = item
        doc = doc_by_id.get(idea.document_id)
        for anchor in idea.anchors:
            counter += 1
            out.append(
                _NumberedAnchor(
                    number=counter, anchor=anchor, idea=idea, doc=doc
                )
            )
    return out


def _render_idea_block(
    *,
    topic: ValidatedCanonicalTopic,
    numbered_anchors: list[_NumberedAnchor],
    idea_by_id: dict[UUID, tuple[Idea, SourceCard]],
    doc_by_id: dict[UUID, DocumentORM],
) -> str:
    anchors_by_idea: dict[UUID, list[_NumberedAnchor]] = {}
    for na in numbered_anchors:
        anchors_by_idea.setdefault(na.idea.idea_id, []).append(na)

    lines: list[str] = []
    for idea_id in topic.subsumed_idea_ids:
        item = idea_by_id.get(idea_id)
        if item is None:
            continue
        idea, card = item
        doc = doc_by_id.get(idea.document_id)

        lines.append(f"### Idea: [{idea.kind}] {idea.label}")
        lines.append(f"Description: {idea.description}")
        if doc is not None:
            label = _source_label(doc)
            lines.append(f"Source: [{label}]({doc.file_path})")
        else:
            lines.append(f"Source: (unresolved document {idea.document_id})")

        for na in anchors_by_idea.get(idea_id, []):
            lines.append(
                f"[^{na.number}] claim: {na.anchor.claim}"
            )
            lines.append(f'     quote: "{na.anchor.quote.strip()}"')
        lines.append("")

    return "\n".join(lines)


def _render_link_targets_block(
    link_targets: list[str], topic_by_slug: dict[str, ValidatedCanonicalTopic]
) -> str:
    lines: list[str] = []
    for slug in link_targets:
        target = topic_by_slug.get(slug)
        if target is None:
            continue
        lines.append(f"- [{target.title}](wiki/{slug}.md) — {target.description}")
    return "\n".join(lines)


def _source_label(doc: DocumentORM) -> str:
    title = (doc.title or "").strip() or "Untitled"
    date = (doc.published_date or "").strip()
    return f"{title} ({date})" if date else title


# ---------------------------------------------------------------------------
# Body validation + post-processing
# ---------------------------------------------------------------------------


def _validate_and_postprocess(
    raw_body: str, numbered_anchors: list[_NumberedAnchor]
) -> str:
    body = raw_body.strip()
    if not body:
        raise ValueError("empty body")
    if body.startswith("---"):
        raise ValueError("body starts with frontmatter delimiter")
    if not _HEADING_RE.search(body):
        raise ValueError("body missing top-level heading")

    anchor_by_number = {na.number: na for na in numbered_anchors}

    # First-appearance order of valid markers.
    used_order: list[int] = []
    for m in _FOOTNOTE_RE.finditer(body):
        n = int(m.group(1))
        if n not in anchor_by_number:
            continue
        if n not in used_order:
            used_order.append(n)

    remap = {orig: display for display, orig in enumerate(used_order, start=1)}

    def _replace(m: re.Match) -> str:
        n = int(m.group(1))
        if n not in remap:
            return ""  # orphan — drop
        return f"[^{remap[n]}]"

    renumbered = _FOOTNOTE_RE.sub(_replace, body)
    # Collapse double spaces introduced by orphan removal at mid-sentence.
    renumbered = re.sub(r"  +", " ", renumbered)

    if not used_order:
        return renumbered.rstrip() + "\n"

    footnotes = ["", "---", ""]
    for display, orig in enumerate(used_order, start=1):
        na = anchor_by_number[orig]
        source_link = _format_source_link(na)
        quote = na.anchor.quote.strip()
        footnotes.append(f'[^{display}]: {source_link} — "{quote}"')

    return renumbered.rstrip() + "\n" + "\n".join(footnotes) + "\n"


def _format_source_link(na: _NumberedAnchor) -> str:
    if na.doc is None:
        return "unknown source"
    label = _source_label(na.doc)
    return f"[{label}]({na.doc.file_path})"


# ---------------------------------------------------------------------------
# Cache key + content hash
# ---------------------------------------------------------------------------


def _topic_content_hash(v: ValidatedCanonicalTopic) -> str:
    parts = [v.title, v.description, *sorted(str(i) for i in v.subsumed_idea_ids)]
    return hashlib.sha256("\n".join(parts).encode()).hexdigest()[:16]


def _cache_key(
    *,
    topic_id: UUID,
    compiled_from_hash: str,
    link_targets: list[str],
    prompt_hash: str,
) -> str:
    h = hashlib.sha256()
    h.update(str(topic_id).encode())
    h.update(f"::{compiled_from_hash}".encode())
    for t in sorted(link_targets):
        h.update(f"::{t}".encode())
    h.update(f"::prompt={prompt_hash}::model={RENDER_MODEL}".encode())
    return h.hexdigest()


# ---------------------------------------------------------------------------
# Shared state loaders
# ---------------------------------------------------------------------------


def _index_ideas(
    cards: list[SourceCard],
) -> dict[UUID, tuple[Idea, SourceCard]]:
    out: dict[UUID, tuple[Idea, SourceCard]] = {}
    for card in cards:
        for idea in card.ideas:
            out[idea.idea_id] = (idea, card)
    return out


async def _load_documents(session, brain_id: UUID) -> dict[UUID, DocumentORM]:
    rows = await session.execute(
        select(DocumentORM).where(DocumentORM.brain_id == brain_id)
    )
    return {row.id: row for row in rows.scalars().all()}
