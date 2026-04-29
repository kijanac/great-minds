"""Phase 5 — verify.

Mechanical. Walks rendered wiki articles, parses actual
[title](wiki/<slug>.md) citations from each body, and builds the
backlinks table from article-level reality (not topic-level intent).

Two lint signals are emitted as log events here (not persisted):
- Unresolved citations: article cites a slug that has no matching
  topic row. Usually an LLM hallucination.
- Unmentioned intended links: an edge in topic_links (from reduce's
  intent via phase 3 derive) whose target doesn't actually appear in
  the source article's prose. Indicates renderer diverged from
  reduce's plan. Diagnostic, not structural.

The lint endpoint re-derives these signals on demand from DB state +
file walk; we log here so compile-time quality is visible without
needing to hit the endpoint.
"""

from __future__ import annotations

import logging
from uuid import UUID

from great_minds.core.documents import Backlink, DocKind, Document, DocumentRepository
from great_minds.core.markdown import extract_wiki_link_targets
from great_minds.core.paths import wiki_path, wiki_slug
from great_minds.core.pipeline.context import PipelineContext
from great_minds.core.telemetry import enrich, log_event
from great_minds.core.topics.repository import TopicRepository
from great_minds.core.topics.schemas import ArticleStatus

log = logging.getLogger(__name__)


async def run(ctx: PipelineContext) -> None:
    rendered = await TopicRepository(ctx.session).list_by_status(
        ctx.brain_id, ArticleStatus.RENDERED
    )
    if not rendered:
        log_event(
            "pipeline.verify_skipped",
            brain_id=str(ctx.brain_id),
            reason="no_rendered_topics",
        )
        return

    slug_to_topic = {t.slug: t for t in rendered}
    topic_id_set = {t.topic_id for t in rendered}
    article_by_path = await _load_wiki_articles(ctx)

    backlinks: list[Backlink] = []
    source_document_ids: list[UUID] = []
    # source_topic_id -> set of cited slugs found in its prose (for unmentioned check)
    cited_by_source: dict[UUID, set[str]] = {}
    unresolved_count = 0
    missing_document_count = 0
    articles_walked = 0

    for topic in rendered:
        article_path = wiki_path(topic.slug)
        content = await ctx.storage.read(article_path, strict=False)
        if content is None:
            # Article status says rendered but file is gone. Skip and log.
            log_event(
                "verify.missing_rendered_file",
                level=logging.WARNING,
                brain_id=str(ctx.brain_id),
                topic_slug=topic.slug,
                topic_id=str(topic.topic_id),
            )
            continue

        source_article = article_by_path.get(article_path)
        if source_article is None:
            missing_document_count += 1
            log_event(
                "verify.missing_source_article_document",
                level=logging.WARNING,
                brain_id=str(ctx.brain_id),
                topic_slug=topic.slug,
                article_path=article_path,
            )
            continue

        source_document_ids.append(source_article.id)
        articles_walked += 1
        link_paths = extract_wiki_link_targets(content)
        cited_slugs: set[str] = set()

        for link in link_paths:
            slug = wiki_slug(link.rsplit("/", 1)[-1])
            target = slug_to_topic.get(slug)
            if target is None:
                unresolved_count += 1
                log_event(
                    "verify.unresolved_citation",
                    level=logging.WARNING,
                    brain_id=str(ctx.brain_id),
                    source_slug=topic.slug,
                    missing_slug=slug,
                )
                continue
            if target.topic_id == topic.topic_id:
                # Self-reference — skip (not a semantic backlink)
                continue
            target_article = article_by_path.get(wiki_path(target.slug))
            if target_article is None:
                missing_document_count += 1
                log_event(
                    "verify.missing_target_article_document",
                    level=logging.WARNING,
                    brain_id=str(ctx.brain_id),
                    source_slug=topic.slug,
                    target_slug=target.slug,
                )
                continue
            cited_slugs.add(slug)
            backlinks.append(
                Backlink(
                    source_document_id=source_article.id,
                    target_document_id=target_article.id,
                )
            )

        cited_by_source[topic.topic_id] = cited_slugs

    # Unmentioned intended links: topic_links edges whose target isn't
    # in cited_by_source[source]. Requires the topic_links rows from
    # phase 3 derive, scoped to this brain.
    unmentioned_count = await _detect_unmentioned_links(
        ctx=ctx,
        topic_id_set=topic_id_set,
        slug_by_topic_id={t.topic_id: t.slug for t in rendered},
        cited_by_source=cited_by_source,
    )

    doc_repo = DocumentRepository(ctx.session)
    await doc_repo.update_wiki_backlinks(
        source_document_ids=source_document_ids,
        backlinks=backlinks,
    )
    await ctx.session.commit()

    enrich(
        verify_articles_walked=articles_walked,
        verify_backlink_edges=len(backlinks),
        verify_unresolved_citations=unresolved_count,
        verify_unmentioned_links=unmentioned_count,
        verify_missing_article_documents=missing_document_count,
    )
    log_event(
        "pipeline.verify_completed",
        brain_id=str(ctx.brain_id),
        articles_walked=articles_walked,
        backlink_edges=len(backlinks),
        unresolved_citations=unresolved_count,
        unmentioned_links=unmentioned_count,
        missing_article_documents=missing_document_count,
    )


async def _load_wiki_articles(ctx: PipelineContext) -> dict[str, Document]:
    docs = await DocumentRepository(ctx.session).list_by_kind(ctx.brain_id, DocKind.WIKI)
    return {doc.file_path: doc for doc in docs}


async def _detect_unmentioned_links(
    *,
    ctx: PipelineContext,
    topic_id_set: set[UUID],
    slug_by_topic_id: dict[UUID, str],
    cited_by_source: dict[UUID, set[str]],
) -> int:
    if not topic_id_set:
        return 0
    edges = await TopicRepository(ctx.session).list_links_for_brain(
        ctx.brain_id, source_topic_ids=list(topic_id_set)
    )

    unmentioned = 0
    for source_id, target_id in edges:
        target_slug = slug_by_topic_id.get(target_id)
        if target_slug is None:
            continue
        cited = cited_by_source.get(source_id, set())
        if target_slug in cited:
            continue
        unmentioned += 1
        log_event(
            "verify.unmentioned_link",
            level=logging.INFO,
            brain_id=str(ctx.brain_id),
            source_slug=slug_by_topic_id.get(source_id, "?"),
            missing_target_slug=target_slug,
        )
    return unmentioned
