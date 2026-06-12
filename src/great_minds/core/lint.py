"""Detection-only lint surfaces for the /lint endpoint.

Runs a set of mechanical queries over post-compile DB state and surfaces
what the user should look at. No LLM calls, no writes, no file reads —
every signal is derived from tables that verify already populated at
compile time (backlinks, topic_links), so the endpoint is a handful of
indexed queries rather than a walk over object storage.

Signals:
- orphans: rendered articles with zero incoming backlinks
- dirty_topics: topics whose rendered_from_hash drifts from current
  compiled_from_hash (compiled inputs shifted since last render)
- unmentioned_links: a topic_links edge (reduce's intent) whose target
  article isn't actually cited in the source article's prose — i.e. the
  intended edge has no matching backlink. Diagnostic: render diverged
  from reduce's plan.

Unresolved citations (prose links to a slug with no live topic) aren't
surfaced here: verify already does the file walk at compile time and
emits them as ``unresolved_citation`` log events. Re-deriving them on
demand would mean re-reading every article body from object storage.
"""

import uuid

from pydantic import BaseModel, Field
from sqlalchemy import exists, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from great_minds.core.documents import WikiArticleOverview, WikiArticleRepo
from great_minds.core.documents.models import BacklinkORM, WikiArticleORM
from great_minds.core.topics.models import TopicLinkORM, TopicORM
from great_minds.core.topics.repository import TopicRepository
from great_minds.core.topics.schemas import ArticleStatus


class UnmentionedLink(BaseModel):
    source_slug: str
    source_title: str
    target_slug: str
    target_title: str


class LintReport(BaseModel):
    orphans: list[WikiArticleOverview] = Field(default_factory=list)
    dirty_topics: list[uuid.UUID] = Field(default_factory=list)
    unmentioned_links: list[UnmentionedLink] = Field(default_factory=list)


async def build_lint_report(session: AsyncSession, vault_id: uuid.UUID) -> LintReport:
    doc_repo = WikiArticleRepo(session)
    topic_repo = TopicRepository(session)
    return LintReport(
        orphans=await doc_repo.list_orphans(vault_id),
        dirty_topics=await topic_repo.list_dirty_topic_ids(vault_id),
        unmentioned_links=await _unmentioned_links(session, vault_id),
    )


async def _unmentioned_links(
    session: AsyncSession, vault_id: uuid.UUID
) -> list[UnmentionedLink]:
    """Intended topic_links edges with no matching backlink.

    topic_links is reduce's intent; backlinks is what render actually
    wrote into the prose. An intended edge between two rendered articles
    whose article pair is absent from backlinks is one the renderer
    didn't honor — the same check verify logs at compile time, here as a
    single anti-join instead of a file walk.
    """
    src_topic = aliased(TopicORM)
    tgt_topic = aliased(TopicORM)
    src_art = aliased(WikiArticleORM)
    tgt_art = aliased(WikiArticleORM)

    realized = exists().where(
        BacklinkORM.source_article_id == src_art.id,
        BacklinkORM.target_article_id == tgt_art.id,
    )
    stmt = (
        select(src_topic.slug, src_topic.title, tgt_topic.slug, tgt_topic.title)
        .select_from(TopicLinkORM)
        .join(src_topic, src_topic.topic_id == TopicLinkORM.source_topic_id)
        .join(tgt_topic, tgt_topic.topic_id == TopicLinkORM.target_topic_id)
        .join(src_art, src_art.topic_id == src_topic.topic_id)
        .join(tgt_art, tgt_art.topic_id == tgt_topic.topic_id)
        .where(
            src_topic.vault_id == vault_id,
            src_topic.article_status == ArticleStatus.RENDERED,
            tgt_topic.article_status == ArticleStatus.RENDERED,
            TopicLinkORM.source_topic_id != TopicLinkORM.target_topic_id,
            ~realized,
        )
        .order_by(func.lower(src_topic.slug), func.lower(tgt_topic.slug))
    )
    rows = (await session.execute(stmt)).all()
    return [
        UnmentionedLink(
            source_slug=r[0],
            source_title=r[1],
            target_slug=r[2],
            target_title=r[3],
        )
        for r in rows
    ]
