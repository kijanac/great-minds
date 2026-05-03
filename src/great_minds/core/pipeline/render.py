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


import asyncio
import logging
import re
from dataclasses import dataclass
from uuid import UUID

from pydantic import BaseModel, ValidationError, field_validator

from great_minds.core.hashing import content_hash, prompt_hash
from great_minds.core.vaults.prompts import load_prompt
from great_minds.core.llm.client import json_llm_call
from great_minds.core.markdown import serialize_frontmatter
from great_minds.core.paths import source_cards_path, wiki_path
from great_minds.core.documents.repository import DocumentRepository
from great_minds.core.documents.schemas import (
    DocKind,
    Document,
    DocumentCreate,
    DocumentMetadata,
)
from great_minds.core.ideas.schemas import Anchor, Idea, SourceCard
from great_minds.core.ideas.source_cards import SourceCardStore, index_ideas_by_id
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


class _RenderOutput(BaseModel):
    """LLM output contract for render. Transient — body is written to
    storage, tags become DocumentMetadata.tags. Never persisted as a
    bundle, so it lives here rather than in a domain schemas module.
    """

    body: str
    tags: list[str]

    @field_validator("tags")
    @classmethod
    def _normalize(cls, raw: list[str]) -> list[str]:
        out: list[str] = []
        seen: set[str] = set()
        for item in raw:
            tag = item.strip().lower().replace(" ", "-")
            if not tag:
                raise ValueError("tag is empty after normalization")
            if tag in seen:
                continue
            seen.add(tag)
            out.append(tag)
        return out


async def run(
    ctx: PipelineContext,
    validated: list[ValidatedCanonicalTopic],
) -> None:
    if not validated:
        log_event(
            "pipeline.render_skipped",
            vault_id=str(ctx.vault_id),
            reason="no_topics",
        )
        return

    prompt_template = await load_prompt(ctx.storage, "render")
    prompt_hash = prompt_hash(prompt_template)

    # Pre-pass: one storage list + N in-memory cache checks decides which
    # topics actually need rendering. On a full-cache-hit replay this
    # short-circuits before any sidecar / DB load — single network
    # roundtrip instead of N storage.exists HEADs.
    existing_wiki = set(await ctx.storage.glob("wiki/*.md"))
    to_render: list[ValidatedCanonicalTopic] = []
    cache_hits = 0
    for topic in validated:
        cache_key = _cache_key(
            topic_id=topic.topic_id,
            compiled_from_hash=_topic_content_hash(topic),
            link_targets=topic.link_targets,
            prompt_hash=prompt_hash,
        )
        if (
            ctx.cache.has(PHASE, cache_key)
            and wiki_path(topic.slug) in existing_wiki
        ):
            cache_hits += 1
            continue
        to_render.append(topic)

    if not to_render:
        enrich(
            render_topics_rendered=cache_hits,
            render_cache_hits=cache_hits,
            render_cache_misses=0,
            render_topics_failed=0,
            render_wiki_chunks_indexed=0,
        )
        log_event(
            "pipeline.render_completed",
            vault_id=str(ctx.vault_id),
            topics_rendered=cache_hits,
            cache_hits=cache_hits,
            cache_misses=0,
            topics_failed=0,
            wiki_chunks_indexed=0,
        )
        return

    # Heavy context loaded only when at least one topic needs rendering.
    source_cards = SourceCardStore(source_cards_path(ctx.sidecar_root)).load_all()
    idea_by_id = index_ideas_by_id(source_cards)
    docs = await _load_documents(ctx.session, ctx.vault_id)
    doc_by_id = {d.id: d for d in docs}
    topic_by_slug = {v.slug: v for v in validated}

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
        for v in to_render
    ]
    outcomes = await asyncio.gather(*tasks)

    repo = TopicRepository(ctx.session)
    cache_misses = 0
    topics_failed = 0
    for outcome in outcomes:
        if outcome.error is not None:
            topics_failed += 1
            continue
        cache_misses += 1
        await repo.set_rendered(
            outcome.topic_id,
            rendered_from_hash=outcome.rendered_from_hash,
        )

    await ctx.session.commit()

    wiki_chunks_indexed = 0
    if cache_misses:
        wiki_chunks_indexed = await rebuild_wiki_index(
            ctx.session, ctx.vault_id, ctx.storage, client=ctx.client
        )

    topics_rendered = cache_hits + cache_misses
    enrich(
        render_topics_rendered=topics_rendered,
        render_cache_hits=cache_hits,
        render_cache_misses=cache_misses,
        render_topics_failed=topics_failed,
        render_wiki_chunks_indexed=wiki_chunks_indexed,
    )
    log_event(
        "pipeline.render_completed",
        vault_id=str(ctx.vault_id),
        topics_rendered=topics_rendered,
        cache_hits=cache_hits,
        cache_misses=cache_misses,
        topics_failed=topics_failed,
        wiki_chunks_indexed=wiki_chunks_indexed,
    )


# ---------------------------------------------------------------------------
# Per-topic render
# ---------------------------------------------------------------------------


@dataclass
class _RenderOutcome:
    topic_id: UUID
    error: str | None = None
    rendered_from_hash: str = ""


async def _render_one(
    *,
    ctx: PipelineContext,
    sem: asyncio.Semaphore,
    topic: ValidatedCanonicalTopic,
    idea_by_id: dict[UUID, tuple[Idea, SourceCard]],
    doc_by_id: dict[UUID, Document],
    topic_by_slug: dict[str, ValidatedCanonicalTopic],
    prompt_template: str,
    prompt_hash: str,
) -> _RenderOutcome:
    """Render one topic. Caller has already determined this is a cache miss."""
    outcome = _RenderOutcome(topic_id=topic.topic_id)
    article_path = wiki_path(topic.slug)

    numbered_anchors = _build_numbered_anchors(topic, idea_by_id, doc_by_id)
    compiled_from_hash = _topic_content_hash(topic)
    cache_key = _cache_key(
        topic_id=topic.topic_id,
        compiled_from_hash=compiled_from_hash,
        link_targets=topic.link_targets,
        prompt_hash=prompt_hash,
    )

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
            data = await json_llm_call(
                ctx.client,
                model=RENDER_MODEL,
                messages=[{"role": "user", "content": prompt}],
                temperature=0.3,
            )
    except Exception as e:
        outcome.error = f"llm_call:{repr(e)[:200]}"
        log_event(
            "render.topic_failed",
            level=logging.WARNING,
            vault_id=str(ctx.vault_id),
            topic_slug=topic.slug,
            error=outcome.error,
        )
        return outcome

    try:
        output = _RenderOutput.model_validate(data)
        body = _validate_and_postprocess(output.body, numbered_anchors)
    except (ValidationError, ValueError) as e:
        outcome.error = f"body_invalid:{type(e).__name__}:{str(e)[:200]}"
        log_event(
            "render.body_invalid",
            level=logging.WARNING,
            vault_id=str(ctx.vault_id),
            topic_slug=topic.slug,
            error=outcome.error,
            response_preview=str(data)[:300],
        )
        return outcome

    tags = output.tags

    fm = {
        "topic_id": str(topic.topic_id),
        "title": topic.title,
        "description": topic.description,
    }
    full_content = serialize_frontmatter(fm, body)
    await ctx.storage.write(article_path, full_content)

    # Index the rendered article in the documents table so /wiki/recent,
    # /raw/sources, and search.rebuild_wiki_index all have consistent
    # metadata. topics is the editorial plan; documents holds the
    # on-disk artifacts (raw + wiki). topic_id is the FK that ties the
    # two together — verify, lint, and archive all join on it.
    doc_repo = DocumentRepository(ctx.session)
    await doc_repo.upsert(
        ctx.vault_id,
        DocumentCreate(
            file_path=article_path,
            content=full_content,
            doc_kind=DocKind.WIKI,
            compiled=True,
            topic_id=topic.topic_id,
            metadata=DocumentMetadata(
                title=topic.title,
                precis=topic.description,
                tags=tags,
            ),
        ),
    )

    ctx.cache.put(PHASE, cache_key, {"body": body, "tags": tags})
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
    doc: Document | None


def _build_numbered_anchors(
    topic: ValidatedCanonicalTopic,
    idea_by_id: dict[UUID, tuple[Idea, SourceCard]],
    doc_by_id: dict[UUID, Document],
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
    doc_by_id: dict[UUID, Document],
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
        lines.append(f"- [{target.title}]({wiki_path(slug)}) — {target.description}")
    return "\n".join(lines)


def _source_label(doc: Document) -> str:
    title = (doc.metadata.title or "").strip() or "Untitled"
    date = (doc.metadata.published_date or "").strip()
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
    # Deep-link to the paragraph via Obsidian-style block ref when the
    # extract phase localized the quote. Works natively in Obsidian;
    # the web viewer's markdown renderer converts `^pN` tokens to
    # HTML anchors so browser fragment-scroll hits the same target.
    path = na.doc.file_path
    if na.anchor.chunk_index is not None:
        path = f"{path}#^p{na.anchor.chunk_index}"
    return f"[{label}]({path})"


# ---------------------------------------------------------------------------
# Cache key + content hash
# ---------------------------------------------------------------------------


def _topic_content_hash(v: ValidatedCanonicalTopic) -> str:
    return content_hash(
        v.title,
        v.description,
        *sorted(str(i) for i in v.subsumed_idea_ids),
    )


def _cache_key(
    *,
    topic_id: UUID,
    compiled_from_hash: str,
    link_targets: list[str],
    prompt_hash: str,
) -> str:
    return content_hash(
        str(topic_id),
        compiled_from_hash,
        *sorted(link_targets),
        f"prompt={prompt_hash}",
        f"model={RENDER_MODEL}",
    )


# ---------------------------------------------------------------------------
# Shared state loaders
# ---------------------------------------------------------------------------


async def _load_documents(session, vault_id: UUID) -> list[Document]:
    """Load raw documents used by anchor footnotes.

    Render's footnotes cite source documents (raw), not wiki articles,
    so the loader filters doc_kind=RAW. Wiki rows exist in the same
    table (render writes them via DocumentRepository.upsert) but would
    never be referenced by anchor.document_id.
    """
    return await DocumentRepository(session).list_by_kind(vault_id, DocKind.RAW)
