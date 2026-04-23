"""Detection-only lint surfaces for the /lint endpoint.

Runs a set of mechanical queries over post-compile state and surfaces
what the user should look at. No LLM calls, no writes, no persistence
— queries re-derive on every request so the view always reflects
current DB state + wiki files on disk.

Signals:
- orphans: rendered topics with zero incoming backlinks
- dirty_topics: topics whose rendered_from_hash drifts from current
  compiled_from_hash (compiled inputs shifted since last render)
- unresolved_citations: wiki article body cites wiki/<slug>.md for
  a slug that has no matching topic row
- unmentioned_links: topic_links edge (reduce's intent) whose target
  doesn't appear in the source article's prose

The research_suggestions and contradictions signals from the six-
phase lint module don't map cleanly onto the topic layer and are
reserved — the endpoint returns empty arrays for both.
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, field

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.core.articles.models import BacklinkORM
from great_minds.core.brain import wiki_slug
from great_minds.core.brain_utils import extract_wiki_link_targets
from great_minds.core.storage import Storage
from great_minds.core.topics.models import TopicLinkORM, TopicORM
from great_minds.core.topics.schemas import ArticleStatus

log = logging.getLogger(__name__)


@dataclass
class Orphan:
    slug: str
    title: str


@dataclass
class UnresolvedCitation:
    source_slug: str
    source_title: str
    missing_slug: str


@dataclass
class UnmentionedLink:
    source_slug: str
    source_title: str
    target_slug: str
    target_title: str


@dataclass
class LintReport:
    orphans: list[Orphan] = field(default_factory=list)
    dirty_topics: list[uuid.UUID] = field(default_factory=list)
    unresolved_citations: list[UnresolvedCitation] = field(default_factory=list)
    unmentioned_links: list[UnmentionedLink] = field(default_factory=list)


async def build_lint_report(
    session: AsyncSession,
    brain_id: uuid.UUID,
    storage: Storage,
) -> LintReport:
    rendered = await _load_rendered_topics(session, brain_id)
    if not rendered:
        dirty = await _dirty_topics(session, brain_id)
        return LintReport(dirty_topics=dirty)

    topic_by_id = {t.topic_id: t for t in rendered}
    slug_to_topic = {t.slug: t for t in rendered}

    orphans = await _orphans(session, brain_id, rendered)
    dirty = await _dirty_topics(session, brain_id)
    unresolved, cited_by_source = _walk_articles(
        storage=storage,
        rendered=rendered,
        slug_to_topic=slug_to_topic,
    )
    unmentioned = await _unmentioned_intended_links(
        session=session,
        topic_by_id=topic_by_id,
        cited_by_source=cited_by_source,
    )

    return LintReport(
        orphans=orphans,
        dirty_topics=dirty,
        unresolved_citations=unresolved,
        unmentioned_links=unmentioned,
    )


async def _load_rendered_topics(
    session: AsyncSession, brain_id: uuid.UUID
) -> list[TopicORM]:
    rows = (
        await session.execute(
            select(TopicORM).where(
                TopicORM.brain_id == brain_id,
                TopicORM.article_status == ArticleStatus.RENDERED.value,
            )
        )
    ).scalars().all()
    return list(rows)


async def _dirty_topics(
    session: AsyncSession, brain_id: uuid.UUID
) -> list[uuid.UUID]:
    """Topics where rendered output doesn't reflect current compiled inputs.

    Never-rendered topics (rendered_from_hash IS NULL) but with a
    compiled_from_hash are also dirty — they've been derived but never
    written.
    """
    result = await session.execute(
        select(TopicORM.topic_id)
        .where(TopicORM.brain_id == brain_id)
        .where(TopicORM.article_status != ArticleStatus.ARCHIVED.value)
        .where(TopicORM.compiled_from_hash.is_not(None))
        .where(
            or_(
                TopicORM.rendered_from_hash.is_(None),
                TopicORM.rendered_from_hash != TopicORM.compiled_from_hash,
            )
        )
    )
    return [row.topic_id for row in result]


async def _orphans(
    session: AsyncSession,
    brain_id: uuid.UUID,
    rendered: list[TopicORM],
) -> list[Orphan]:
    """Rendered topics with zero incoming backlinks."""
    if not rendered:
        return []
    rendered_ids = [t.topic_id for t in rendered]
    # Topics that appear as target in at least one backlink
    has_incoming = (
        await session.execute(
            select(BacklinkORM.target_topic_id)
            .where(BacklinkORM.target_topic_id.in_(rendered_ids))
            .distinct()
        )
    ).scalars().all()
    has_incoming_set = set(has_incoming)
    orphans = [
        Orphan(slug=t.slug, title=t.title)
        for t in rendered
        if t.topic_id not in has_incoming_set
    ]
    orphans.sort(key=lambda o: o.title.lower())
    return orphans


def _walk_articles(
    *,
    storage: Storage,
    rendered: list[TopicORM],
    slug_to_topic: dict[str, TopicORM],
) -> tuple[list[UnresolvedCitation], dict[uuid.UUID, set[str]]]:
    """Parse citations from every rendered article's prose.

    Returns (unresolved_citations, {source_topic_id: cited_slugs}).
    Re-walks wiki files on every lint request — cheap at typical scale
    and always reflects current file state, catching manual edits.
    """
    unresolved: list[UnresolvedCitation] = []
    cited_by_source: dict[uuid.UUID, set[str]] = {}

    for topic in rendered:
        wiki_path = f"wiki/{topic.slug}.md"
        content = storage.read(wiki_path, strict=False)
        if content is None:
            continue
        cited_slugs: set[str] = set()
        for path in extract_wiki_link_targets(content):
            slug = wiki_slug(path.rsplit("/", 1)[-1])
            target = slug_to_topic.get(slug)
            if target is None:
                unresolved.append(
                    UnresolvedCitation(
                        source_slug=topic.slug,
                        source_title=topic.title,
                        missing_slug=slug,
                    )
                )
                continue
            if target.topic_id == topic.topic_id:
                continue
            cited_slugs.add(slug)
        cited_by_source[topic.topic_id] = cited_slugs

    unresolved.sort(key=lambda u: (u.source_slug, u.missing_slug))
    return unresolved, cited_by_source


async def _unmentioned_intended_links(
    *,
    session: AsyncSession,
    topic_by_id: dict[uuid.UUID, TopicORM],
    cited_by_source: dict[uuid.UUID, set[str]],
) -> list[UnmentionedLink]:
    """topic_links edges whose target isn't in the source article's prose.

    Reduce said the article should link there; renderer didn't comply.
    Diagnostic, not structural — shows up when reduce's judgment and
    render's output diverge.
    """
    if not cited_by_source:
        return []
    source_ids = list(cited_by_source.keys())
    edges = (
        await session.execute(
            select(TopicLinkORM.source_topic_id, TopicLinkORM.target_topic_id)
            .where(TopicLinkORM.source_topic_id.in_(source_ids))
        )
    ).all()

    out: list[UnmentionedLink] = []
    for source_id, target_id in edges:
        source = topic_by_id.get(source_id)
        target = topic_by_id.get(target_id)
        if source is None or target is None:
            continue
        if target.slug in cited_by_source.get(source_id, set()):
            continue
        out.append(
            UnmentionedLink(
                source_slug=source.slug,
                source_title=source.title,
                target_slug=target.slug,
                target_title=target.title,
            )
        )
    out.sort(key=lambda u: (u.source_slug, u.target_slug))
    return out
