"""Lint route — detection-only, on-demand.

Runs DB queries + wiki-file walk per request and returns a report.
Frontend polls this endpoint via useExploreBadge; the Explore page
surfaces findings as automatic notifications (no "run lint" button).

Shape reflects the topic-based architecture directly:
- orphans: rendered articles with no incoming backlinks
- dirty_topics: topic_ids whose rendered output lags behind current
  compiled_from_hash
- unresolved_citations: article body cites a slug with no matching
  topic row
- unmentioned_links: topic_links (reduce's intent) edges that don't
  appear in the source article's prose
"""

from uuid import UUID

from fastapi import APIRouter, Depends, Path
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.app.api.dependencies import (
    BrainMemberGuard,
    BrainStorageDep,
)
from great_minds.core.db import get_session
from great_minds.core.lint import build_lint_report

router = APIRouter(prefix="/lint", tags=["lint"])


class OrphanResponse(BaseModel):
    slug: str
    title: str


class UnresolvedCitationResponse(BaseModel):
    source_slug: str
    source_title: str
    missing_slug: str


class UnmentionedLinkResponse(BaseModel):
    source_slug: str
    source_title: str
    target_slug: str
    target_title: str


class LintReportResponse(BaseModel):
    orphans: list[OrphanResponse]
    dirty_topics: list[UUID]
    unresolved_citations: list[UnresolvedCitationResponse]
    unmentioned_links: list[UnmentionedLinkResponse]


@router.get("")
async def lint(
    storage: BrainStorageDep,
    _auth: BrainMemberGuard,
    brain_id: UUID = Path(...),
    session: AsyncSession = Depends(get_session),
) -> LintReportResponse:
    report = await build_lint_report(session, brain_id, storage)
    return LintReportResponse(
        orphans=[
            OrphanResponse(slug=o.slug, title=o.title)
            for o in report.orphans
        ],
        dirty_topics=report.dirty_topics,
        unresolved_citations=[
            UnresolvedCitationResponse(
                source_slug=u.source_slug,
                source_title=u.source_title,
                missing_slug=u.missing_slug,
            )
            for u in report.unresolved_citations
        ],
        unmentioned_links=[
            UnmentionedLinkResponse(
                source_slug=u.source_slug,
                source_title=u.source_title,
                target_slug=u.target_slug,
                target_title=u.target_title,
            )
            for u in report.unmentioned_links
        ],
    )
