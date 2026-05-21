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

from openai import AsyncOpenAI
from pydantic import BaseModel, ValidationError, field_validator
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.core.compile_cache import CompileCacheRepository
from great_minds.core.hashing import content_hash, prompt_hash
from great_minds.core.vaults.prompts import load_prompt
from great_minds.core.llm.client import json_llm_call
from great_minds.core.markdown import serialize_frontmatter
from great_minds.core.paths import wiki_path
from great_minds.core.documents import SourceDocumentService, WikiArticleService
from great_minds.core.documents.schemas import (
    WikiArticleCreate,
)
from great_minds.core.documents.schemas import SourceDocument
from great_minds.core.ideas.schemas import Anchor, Idea
from great_minds.core.ideas.service import IdeaService
from great_minds.core.llm import RENDER_MODEL
from great_minds.core.topics.schemas import TopicDetail
from great_minds.core.pipeline.steps import StepRunner
from great_minds.core.pipeline_runs import (
    PipelineProgressRunner,
    PipelineProgressStep,
    build_progress_steps,
)
from great_minds.core.search import SearchService
from great_minds.core.storage import Storage
from great_minds.core.telemetry import enrich, log_event
from great_minds.core.topics.service import TopicService

log = logging.getLogger(__name__)

PHASE = "render"
_FOOTNOTE_RE = re.compile(r"\[\^(\d+)\]")
_HEADING_RE = re.compile(r"^# ", re.MULTILINE)


class _RenderOutput(BaseModel):
    """LLM output contract for render. Transient — body is written to
    storage, tags land on the wiki article's row. Never persisted as a
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


RENDER_STEP_LABELS = {
    "plan_articles": "Planning articles",
    "write_articles": "Writing articles",
    "index_articles": "Indexing articles",
}


class RenderPhase:
    """Phase 4 runner with explicit service-style dependencies."""

    def __init__(
        self,
        *,
        storage: Storage,
        client: AsyncOpenAI,
        session: AsyncSession,
        progress: PipelineProgressRunner,
        compile_cache: CompileCacheRepository,
        steps: StepRunner,
        source_docs: SourceDocumentService,
        wiki_articles: WikiArticleService,
        topics: TopicService,
        search: SearchService,
        ideas: IdeaService,
        concurrency: int,
    ) -> None:
        self.storage = storage
        self.client = client
        self.session = session
        self.progress = progress
        self.compile_cache = compile_cache
        self.steps = steps
        self.source_docs = source_docs
        self.wiki_articles = wiki_articles
        self.topics = topics
        self.search = search
        self.ideas = ideas
        self.concurrency = concurrency
        # Set per-run in run(); read by _write_rendered_article to stamp
        # provenance on each article it writes.
        self.pipeline_run_id: UUID | None = None

    def progress_steps(
        self,
        active: str,
        *,
        completed: set[str] | None = None,
        counts: dict[str, tuple[int | None, int | None]] | None = None,
    ) -> list[PipelineProgressStep]:
        return build_progress_steps(
            RENDER_STEP_LABELS,
            active,
            completed=completed,
            counts=counts,
        )

    async def run(
        self,
        vault_id: UUID,
        pipeline_run_id: UUID,
        validated: list[TopicDetail],
    ) -> None:
        self.pipeline_run_id = pipeline_run_id
        if not validated:
            log_event(
                "skipped",
                reason="no_topics",
            )
            return

        await self.progress.emit(
            pipeline_run_id=pipeline_run_id,
            phase="render",
            status="progress",
            steps=self.progress_steps(
                "plan_articles",
                counts={"plan_articles": (0, len(validated))},
            ),
        )
        prompt_template = await load_prompt(self.storage, "render")
        ph = prompt_hash(prompt_template)

        # Pre-pass: one storage list + N DB cache checks decides which topics
        # need LLM rendering, which can be skipped, and which have a cached
        # body/tags payload that can repair a missing wiki file.
        existing_wiki = {f.path for f in await self.storage.glob("wiki/*.md")}
        to_render: list[TopicDetail] = []
        to_materialize: list[tuple[TopicDetail, _RenderOutput]] = []
        cache_hits = 0
        cache_invalid = 0
        planned = 0
        for topic in validated:
            cache_key = _cache_key(
                topic_id=topic.topic_id,
                compiled_from_hash=_topic_content_hash(topic),
                link_targets=topic.link_targets,
                prompt_hash=ph,
            )
            cached = await self.compile_cache.get(
                vault_id=vault_id,
                phase=PHASE,
                cache_key=cache_key,
            )
            planned += 1
            await self.progress.emit(
                pipeline_run_id=pipeline_run_id,
                phase="render",
                status="progress",
                steps=self.progress_steps(
                    "plan_articles",
                    counts={"plan_articles": (planned, len(validated))},
                ),
            )
            if cached is None:
                to_render.append(topic)
                continue
            try:
                output = _RenderOutput.model_validate(cached)
            except ValidationError:
                cache_invalid += 1
                to_render.append(topic)
                continue
            if wiki_path(topic.slug) in existing_wiki:
                cache_hits += 1
                continue
            to_materialize.append((topic, output))

        materialized = 0
        for topic, output in to_materialize:
            compiled_from_hash = await _write_rendered_article(
                phase=self,
                vault_id=vault_id,
                topic=topic,
                body=output.body,
                tags=output.tags,
            )
            await self.topics.set_rendered(
                topic.topic_id, rendered_from_hash=compiled_from_hash
            )
            materialized += 1

        await self.session.commit()

        if not to_render:
            wiki_chunks_indexed = 0
            if materialized:
                await self.progress.emit(
                    pipeline_run_id=pipeline_run_id,
                    phase="render",
                    status="progress",
                    steps=self.progress_steps(
                        "index_articles",
                        completed={"plan_articles"},
                        counts={"plan_articles": (len(validated), len(validated))},
                    ),
                )
                wiki_chunks_indexed = await self.search.rebuild_wiki_index(
                    vault_id,
                    self.storage,
                    client=self.client,
                    progress=self.progress,
                    pipeline_run_id=pipeline_run_id,
                )
            topics_rendered = cache_hits + materialized
            enrich(
                render_topics_rendered=topics_rendered,
                render_cache_hits=cache_hits + materialized,
                render_cache_misses=0,
                render_topics_failed=0,
                render_cache_invalid=cache_invalid,
                render_wiki_chunks_indexed=wiki_chunks_indexed,
            )
            log_event(
                "completed",
                topics_rendered=topics_rendered,
                cache_hits=cache_hits,
                cache_materialized=materialized,
                cache_misses=0,
                cache_invalid=cache_invalid,
                topics_failed=0,
                wiki_chunks_indexed=wiki_chunks_indexed,
            )
            await self.progress.emit(
                pipeline_run_id=pipeline_run_id,
                phase="render",
                status="completed",
                steps=self.progress_steps(
                    "index_articles",
                    completed=set(RENDER_STEP_LABELS),
                    counts={"plan_articles": (len(validated), len(validated))},
                ),
            )
            return

        await self.progress.emit(
            pipeline_run_id=pipeline_run_id,
            phase="render",
            status="progress",
            steps=self.progress_steps(
                "write_articles",
                completed={"plan_articles"},
                counts={
                    "plan_articles": (len(validated), len(validated)),
                    "write_articles": (0, len(to_render)),
                },
            ),
        )

        # Heavy context loaded only when at least one topic needs rendering.
        needed_idea_ids = {
            idea_id for topic in to_render for idea_id in topic.subsumed_idea_ids
        }
        idea_by_id = await self.ideas.get_ideas_by_id(needed_idea_ids)
        docs = await self.source_docs.list_all(vault_id)
        doc_by_id = {d.id: d for d in docs}
        topic_by_slug = {v.slug: v for v in validated}

        sem = asyncio.Semaphore(self.concurrency)

        tasks = [
            _render_one(
                phase=self,
                sem=sem,
                vault_id=vault_id,
                topic=v,
                idea_by_id=idea_by_id,
                doc_by_id=doc_by_id,
                topic_by_slug=topic_by_slug,
                prompt_template=prompt_template,
                prompt_hash=ph,
            )
            for v in to_render
        ]
        outcomes: list[_RenderOutcome] = []
        topics_done = 0
        for task in asyncio.as_completed(tasks):
            outcome = await task
            outcomes.append(outcome)
            topics_done += 1
            await self.progress.emit(
                pipeline_run_id=pipeline_run_id,
                phase="render",
                status="progress",
                steps=self.progress_steps(
                    "write_articles",
                    completed={"plan_articles"},
                    counts={
                        "plan_articles": (len(validated), len(validated)),
                        "write_articles": (topics_done, len(to_render)),
                    },
                ),
            )

        cache_misses = 0
        topics_failed = 0
        for outcome in outcomes:
            if outcome.error is not None:
                topics_failed += 1
                continue
            cache_misses += 1
            await self.topics.set_rendered(
                outcome.topic_id,
                rendered_from_hash=outcome.rendered_from_hash,
            )

        await self.session.commit()

        wiki_chunks_indexed = 0
        if materialized or cache_misses:
            await self.progress.emit(
                pipeline_run_id=pipeline_run_id,
                phase="render",
                status="progress",
                steps=self.progress_steps(
                    "index_articles",
                    completed={"plan_articles", "write_articles"},
                    counts={
                        "plan_articles": (len(validated), len(validated)),
                        "write_articles": (topics_done, len(to_render)),
                    },
                ),
            )
            wiki_chunks_indexed = await self.search.rebuild_wiki_index(
                vault_id,
                self.storage,
                client=self.client,
                progress=self.progress,
                pipeline_run_id=pipeline_run_id,
            )

        topics_rendered = cache_hits + materialized + cache_misses
        enrich(
            render_topics_rendered=topics_rendered,
            render_cache_hits=cache_hits + materialized,
            render_cache_misses=cache_misses,
            render_topics_failed=topics_failed,
            render_cache_invalid=cache_invalid,
            render_wiki_chunks_indexed=wiki_chunks_indexed,
        )
        log_event(
            "completed",
            topics_rendered=topics_rendered,
            cache_hits=cache_hits,
            cache_materialized=materialized,
            cache_misses=cache_misses,
            cache_invalid=cache_invalid,
            topics_failed=topics_failed,
            wiki_chunks_indexed=wiki_chunks_indexed,
        )
        await self.progress.emit(
            pipeline_run_id=pipeline_run_id,
            phase="render",
            status="completed",
            steps=self.progress_steps(
                "index_articles",
                completed=set(RENDER_STEP_LABELS),
                counts={
                    "plan_articles": (len(validated), len(validated)),
                    "write_articles": (topics_done, len(to_render)),
                },
            ),
        )


# ---------------------------------------------------------------------------
# Per-topic render
# ---------------------------------------------------------------------------


@dataclass
class _RenderOutcome:
    topic_id: UUID
    error: str | None = None
    rendered_from_hash: str = ""


async def _write_rendered_article(
    *,
    phase: RenderPhase,
    vault_id: UUID,
    topic: TopicDetail,
    body: str,
    tags: list[str],
) -> str:
    """Materialize a rendered body/tags pair into storage + document index."""
    article_path = wiki_path(topic.slug)
    fm = {
        "topic_id": str(topic.topic_id),
        "title": topic.title,
        "description": topic.description,
    }
    full_content = serialize_frontmatter(fm, body)
    await phase.storage.write(article_path, full_content)

    # Index the rendered article in the documents table so /wiki/recent,
    # /raw/sources, and search.rebuild_wiki_index all have consistent
    # metadata. topics is the editorial plan; documents holds the
    # on-disk artifacts (raw + wiki). topic_id is the FK that ties the
    # two together — verify, lint, and archive all join on it.
    await phase.wiki_articles.upsert(
        vault_id,
        WikiArticleCreate(
            file_path=article_path,
            content=full_content,
            topic_id=topic.topic_id,
            title=topic.title,
            precis=topic.description,
            render_run_id=phase.pipeline_run_id,
        ),
    )
    return _topic_content_hash(topic)


async def _call_render_llm(
    phase: RenderPhase,
    sem: asyncio.Semaphore,
    prompt: str,
) -> dict:
    async with sem:
        return await json_llm_call(
            phase.client,
            model=RENDER_MODEL,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.3,
        )


async def _render_one(
    *,
    phase: RenderPhase,
    sem: asyncio.Semaphore,
    vault_id: UUID,
    topic: TopicDetail,
    idea_by_id: dict[UUID, Idea],
    doc_by_id: dict[UUID, SourceDocument],
    topic_by_slug: dict[str, TopicDetail],
    prompt_template: str,
    prompt_hash: str,
) -> _RenderOutcome:
    """Render one topic. Caller has already determined this is a cache miss."""
    outcome = _RenderOutcome(topic_id=topic.topic_id)

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
    link_targets_block = _render_link_targets_block(topic.link_targets, topic_by_slug)
    prompt = (
        prompt_template.replace("{title}", topic.title)
        .replace("{description}", topic.description)
        .replace("{idea_block}", idea_block)
        .replace("{link_targets_block}", link_targets_block or "(none)")
    )

    try:
        data = await phase.steps.step(
            f"render-topic-llm-{topic.topic_id}-{cache_key}",
            _call_render_llm,
            phase,
            sem,
            prompt,
        )
    except Exception as e:
        outcome.error = f"llm_call:{repr(e)[:200]}"
        log_event(
            "topic_failed",
            level=logging.WARNING,
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
            "body_invalid",
            level=logging.WARNING,
            topic_slug=topic.slug,
            error=outcome.error,
            response_preview=str(data)[:300],
        )
        return outcome

    tags = output.tags

    await _write_rendered_article(
        phase=phase, vault_id=vault_id, topic=topic, body=body, tags=tags
    )

    await phase.compile_cache.put(
        vault_id=vault_id,
        phase=PHASE,
        cache_key=cache_key,
        value={"body": body, "tags": tags},
    )
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
    doc: SourceDocument | None


def _build_numbered_anchors(
    topic: TopicDetail,
    idea_by_id: dict[UUID, Idea],
    doc_by_id: dict[UUID, SourceDocument],
) -> list[_NumberedAnchor]:
    out: list[_NumberedAnchor] = []
    counter = 0
    for idea_id in topic.subsumed_idea_ids:
        idea = idea_by_id.get(idea_id)
        if idea is None:
            continue
        doc = doc_by_id.get(idea.document_id)
        for anchor in idea.anchors:
            counter += 1
            out.append(
                _NumberedAnchor(number=counter, anchor=anchor, idea=idea, doc=doc)
            )
    return out


def _render_idea_block(
    *,
    topic: TopicDetail,
    numbered_anchors: list[_NumberedAnchor],
    idea_by_id: dict[UUID, Idea],
    doc_by_id: dict[UUID, SourceDocument],
) -> str:
    anchors_by_idea: dict[UUID, list[_NumberedAnchor]] = {}
    for na in numbered_anchors:
        anchors_by_idea.setdefault(na.idea.idea_id, []).append(na)

    lines: list[str] = []
    for idea_id in topic.subsumed_idea_ids:
        idea = idea_by_id.get(idea_id)
        if idea is None:
            continue
        doc = doc_by_id.get(idea.document_id)

        lines.append(f"### Idea: [{idea.kind}] {idea.label}")
        lines.append(f"Description: {idea.description}")
        if doc is not None:
            label = _source_label(doc)
            lines.append(f"Source: [{label}]({doc.file_path})")
        else:
            lines.append(f"Source: (unresolved document {idea.document_id})")

        for na in anchors_by_idea.get(idea_id, []):
            # Only the claim + anchor number go in the prompt — enough for
            # the model to place [^N] citations. The verbatim quote and
            # source link are restored code-side in _validate_and_postprocess
            # from numbered_anchors, so omitting quotes here cuts prompt size
            # dramatically (the 1M-token render failures) with zero loss of
            # citation fidelity in the rendered article.
            lines.append(f"[^{na.number}] claim: {na.anchor.claim}")
        lines.append("")

    return "\n".join(lines)


def _render_link_targets_block(
    link_targets: list[str], topic_by_slug: dict[str, TopicDetail]
) -> str:
    lines: list[str] = []
    for slug in link_targets:
        target = topic_by_slug.get(slug)
        if target is None:
            continue
        lines.append(f"- [{target.title}]({wiki_path(slug)}) — {target.description}")
    return "\n".join(lines)


def _source_label(doc: SourceDocument) -> str:
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


def _topic_content_hash(v: TopicDetail) -> str:
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
