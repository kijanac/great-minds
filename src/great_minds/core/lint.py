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

import uuid
from dataclasses import dataclass, field

from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.core.articles.repository import BacklinkRepository
from great_minds.core.markdown import extract_wiki_link_targets
from great_minds.core.paths import wiki_path, wiki_slug
from great_minds.core.storage import Storage
from great_minds.core.topics.repository import TopicRepository
from great_minds.core.topics.schemas import ArticleStatus, Topic


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
    topic_repo = TopicRepository(session)
    backlink_repo = BacklinkRepository(session)

    rendered = await topic_repo.list_by_status(brain_id, ArticleStatus.RENDERED)
    if not rendered:
        dirty = await topic_repo.list_dirty_topic_ids(brain_id)
        return LintReport(dirty_topics=dirty)

    topic_by_id = {t.topic_id: t for t in rendered}
    slug_to_topic = {t.slug: t for t in rendered}

    orphans = await _orphans(backlink_repo, rendered)
    dirty = await topic_repo.list_dirty_topic_ids(brain_id)
    unresolved, cited_by_source = await _walk_articles(
        storage=storage,
        rendered=rendered,
        slug_to_topic=slug_to_topic,
    )
    unmentioned = await _unmentioned_intended_links(
        topic_repo=topic_repo,
        brain_id=brain_id,
        topic_by_id=topic_by_id,
        cited_by_source=cited_by_source,
    )

    return LintReport(
        orphans=orphans,
        dirty_topics=dirty,
        unresolved_citations=unresolved,
        unmentioned_links=unmentioned,
    )


async def _orphans(
    backlink_repo: BacklinkRepository,
    rendered: list[Topic],
) -> list[Orphan]:
    """Rendered topics with zero incoming backlinks."""
    if not rendered:
        return []
    rendered_ids = [t.topic_id for t in rendered]
    has_incoming = await backlink_repo.filter_targets_with_incoming(rendered_ids)
    orphans = [
        Orphan(slug=t.slug, title=t.title)
        for t in rendered
        if t.topic_id not in has_incoming
    ]
    orphans.sort(key=lambda o: o.title.lower())
    return orphans


async def _walk_articles(
    *,
    storage: Storage,
    rendered: list[Topic],
    slug_to_topic: dict[str, Topic],
) -> tuple[list[UnresolvedCitation], dict[uuid.UUID, set[str]]]:
    """Parse citations from every rendered article's prose.

    Returns (unresolved_citations, {source_topic_id: cited_slugs}).
    Re-walks wiki files on every lint request — cheap at typical scale
    and always reflects current file state, catching manual edits.
    """
    unresolved: list[UnresolvedCitation] = []
    cited_by_source: dict[uuid.UUID, set[str]] = {}

    for topic in rendered:
        content = await storage.read(wiki_path(topic.slug), strict=False)
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
    topic_repo: TopicRepository,
    brain_id: uuid.UUID,
    topic_by_id: dict[uuid.UUID, Topic],
    cited_by_source: dict[uuid.UUID, set[str]],
) -> list[UnmentionedLink]:
    """topic_links edges whose target isn't in the source article's prose.

    Reduce said the article should link there; renderer didn't comply.
    Diagnostic, not structural — shows up when reduce's judgment and
    render's output diverge.
    """
    if not cited_by_source:
        return []
    edges = await topic_repo.list_links_for_brain(
        brain_id, source_topic_ids=list(cited_by_source.keys())
    )

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
