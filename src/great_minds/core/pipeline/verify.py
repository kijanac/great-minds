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

import logging
from uuid import UUID

from great_minds.core.documents import Backlink, WikiArticle, WikiArticleService
from great_minds.core.markdown import extract_wiki_link_targets
from great_minds.core.paths import wiki_path, wiki_slug
from great_minds.core.pipeline_runs import (
    PipelineProgressRunner,
    PipelineProgressStep,
    build_progress_steps,
)
from great_minds.core.storage import Storage
from great_minds.core.telemetry import enrich, log_event
from great_minds.core.topics.schemas import ArticleStatus
from great_minds.core.topics.service import TopicService

log = logging.getLogger(__name__)

VERIFY_STEP_LABELS = {
    "load_articles": "Loading articles",
    "check_links": "Checking links",
    "record_findings": "Recording findings",
}


class VerifyPhase:
    """Phase 5 runner with explicit service-style dependencies."""

    def __init__(
        self,
        *,
        storage: Storage,
        topics: TopicService,
        wiki_articles: WikiArticleService,
        progress: PipelineProgressRunner,
        pipeline_run_id: UUID,
    ) -> None:
        self.storage = storage
        self.topics = topics
        self.wiki_articles = wiki_articles
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
            VERIFY_STEP_LABELS,
            active,
            completed=completed,
            counts=counts,
        )

    async def run(self, vault_id: UUID) -> None:
        await self.progress.emit(
            pipeline_run_id=self.pipeline_run_id,
            phase="verify",
            status="progress",
            steps=self.progress_steps("load_articles"),
        )
        rendered = await self.topics.list_for_vault(vault_id, ArticleStatus.RENDERED)
        if not rendered:
            log_event(
                "skipped",
                reason="no_rendered_topics",
            )
            await self.progress.emit(
                pipeline_run_id=self.pipeline_run_id,
                phase="verify",
                status="completed",
                steps=self.progress_steps(
                    "load_articles", completed=set(VERIFY_STEP_LABELS)
                ),
            )
            return

        await self.progress.emit(
            pipeline_run_id=self.pipeline_run_id,
            phase="verify",
            status="progress",
            steps=self.progress_steps(
                "check_links",
                completed={"load_articles"},
                counts={"check_links": (0, len(rendered))},
            ),
        )
        slug_to_topic = {t.slug: t for t in rendered}
        topic_id_set = {t.topic_id for t in rendered}
        article_by_topic = await self._load_wiki_articles(vault_id)

        backlinks: list[Backlink] = []
        source_article_ids: list[UUID] = []
        # source_topic_id -> set of cited slugs found in its prose (for unmentioned check)
        cited_by_source: dict[UUID, set[str]] = {}
        unresolved_count = 0
        articles_walked = 0

        # FK + partial unique index guarantee a wiki document for every
        # rendered topic (render commits both writes in one transaction),
        # so dict access by topic_id is total — KeyError would surface real
        # schema corruption rather than expected absence.
        for topic in rendered:
            article_path = wiki_path(topic.slug)
            content = await self.storage.read(article_path, strict=False)
            if content is None:
                # Article status says rendered but file is gone. Skip and log.
                log_event(
                    "missing_rendered_file",
                    level=logging.WARNING,
                    topic_slug=topic.slug,
                    topic_id=str(topic.topic_id),
                )
                continue

            source_article = article_by_topic[topic.topic_id]
            source_article_ids.append(source_article.id)
            articles_walked += 1
            link_paths = extract_wiki_link_targets(content)
            cited_slugs: set[str] = set()

            for link in link_paths:
                slug = wiki_slug(link.rsplit("/", 1)[-1])
                target = slug_to_topic.get(slug)
                if target is None:
                    unresolved_count += 1
                    log_event(
                        "unresolved_citation",
                        level=logging.WARNING,
                        source_slug=topic.slug,
                        missing_slug=slug,
                    )
                    continue
                if target.topic_id == topic.topic_id:
                    # Self-reference — skip (not a semantic backlink)
                    continue
                target_article = article_by_topic[target.topic_id]
                cited_slugs.add(slug)
                backlinks.append(
                    Backlink(
                        source_article_id=source_article.id,
                        target_article_id=target_article.id,
                    )
                )

            cited_by_source[topic.topic_id] = cited_slugs
            await self.progress.emit(
                pipeline_run_id=self.pipeline_run_id,
                phase="verify",
                status="progress",
                steps=self.progress_steps(
                    "check_links",
                    completed={"load_articles"},
                    counts={"check_links": (articles_walked, len(rendered))},
                ),
            )

        await self.progress.emit(
            pipeline_run_id=self.pipeline_run_id,
            phase="verify",
            status="progress",
            steps=self.progress_steps(
                "record_findings",
                completed={"load_articles", "check_links"},
                counts={"check_links": (articles_walked, len(rendered))},
            ),
        )

        # Unmentioned intended links: topic_links edges whose target isn't
        # in cited_by_source[source]. Requires the topic_links rows from
        # phase 3 derive, scoped to this vault.
        unmentioned_count = await self._detect_unmentioned_links(
            vault_id=vault_id,
            topic_id_set=topic_id_set,
            slug_by_topic_id={t.topic_id: t.slug for t in rendered},
            cited_by_source=cited_by_source,
        )

        await self.wiki_articles.replace_backlinks(
            source_ids=source_article_ids,
            backlinks=backlinks,
        )

        enrich(
            verify_articles_walked=articles_walked,
            verify_backlink_edges=len(backlinks),
            verify_unresolved_citations=unresolved_count,
            verify_unmentioned_links=unmentioned_count,
        )
        log_event(
            "completed",
            articles_walked=articles_walked,
            backlink_edges=len(backlinks),
            unresolved_citations=unresolved_count,
            unmentioned_links=unmentioned_count,
        )
        await self.progress.emit(
            pipeline_run_id=self.pipeline_run_id,
            phase="verify",
            status="completed",
            steps=self.progress_steps(
                "record_findings",
                completed=set(VERIFY_STEP_LABELS),
                counts={"check_links": (articles_walked, len(rendered))},
            ),
        )

    async def _load_wiki_articles(self, vault_id: UUID) -> dict[UUID, WikiArticle]:
        """Map topic_id → WikiArticle."""
        articles = await self.wiki_articles.list_all(vault_id)
        return {a.topic_id: a for a in articles}

    async def _detect_unmentioned_links(
        self,
        *,
        vault_id: UUID,
        topic_id_set: set[UUID],
        slug_by_topic_id: dict[UUID, str],
        cited_by_source: dict[UUID, set[str]],
    ) -> int:
        if not topic_id_set:
            return 0
        edges = await self.topics.list_links_for_vault(
            vault_id, source_topic_ids=list(topic_id_set)
        )

        unmentioned = 0
        for edge in edges:
            target_slug = slug_by_topic_id.get(edge.target_topic_id)
            if target_slug is None:
                continue
            cited = cited_by_source.get(edge.source_topic_id, set())
            if target_slug in cited:
                continue
            unmentioned += 1
            log_event(
                "unmentioned_link",
                level=logging.INFO,
                source_slug=slug_by_topic_id[edge.source_topic_id],
                missing_target_slug=target_slug,
            )
        return unmentioned
