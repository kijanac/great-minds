"""Lint route — detection-only, on-demand.

Runs DB queries + wiki-file walk per request and returns a report.
Frontend polls this endpoint via useExploreBadge; the Explore page
surfaces findings as automatic notifications (no "run lint" button).

Shape reflects the topic-based architecture directly:
- orphans: rendered topics with no incoming backlinks
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
    get_brain_storage,
    require_brain_member,
)
from great_minds.core.db import get_session
from great_minds.core.lint import build_lint_report
from great_minds.core.storage import Storage

router = APIRouter(prefix="/lint", tags=["lint"])


class OrphanResponse(BaseModel):
    slug: str
    title: str


class UnresolvedCitationResponse(BaseModel):
    source_slug: str
    missing_slug: str


class UnmentionedLinkResponse(BaseModel):
    source_slug: str
    target_slug: str


class LintReportResponse(BaseModel):
    orphans: list[OrphanResponse]
    dirty_topics: list[UUID]
    unresolved_citations: list[UnresolvedCitationResponse]
    unmentioned_links: list[UnmentionedLinkResponse]


@router.get("")
async def lint(
    brain_id: UUID = Path(...),
    session: AsyncSession = Depends(get_session),
    storage: Storage = Depends(get_brain_storage),
    _auth: None = Depends(require_brain_member),
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
                source_slug=u.source_slug, missing_slug=u.missing_slug
            )
            for u in report.unresolved_citations
        ],
        unmentioned_links=[
            UnmentionedLinkResponse(
                source_slug=u.source_slug, target_slug=u.target_slug
            )
            for u in report.unmentioned_links
        ],
    )
