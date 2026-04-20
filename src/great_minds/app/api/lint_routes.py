"""Lint route — serves the Phase 6 detection report on demand.

Lint never authors source material. GET /lint runs a set of mechanical
SQL queries over the post-compile state and returns a report the user
can act on from the Explore page. See core/subjects/lint.py for the
detection logic.
"""

from uuid import UUID

from fastapi import APIRouter, Depends, Path
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.app.api.dependencies import require_brain_member
from great_minds.core.db import get_session
from great_minds.core.subjects.lint import build_lint_report

router = APIRouter(prefix="/lint", tags=["lint"])


class ResearchSuggestionResponse(BaseModel):
    topic: str
    mentioned_in: list[str]
    usage_count: int


class OrphanResponse(BaseModel):
    slug: str
    canonical_label: str


class ContradictionResponse(BaseModel):
    description: str
    articles: list[str]


class LintReportResponse(BaseModel):
    research_suggestions: list[ResearchSuggestionResponse]
    orphans: list[OrphanResponse]
    dirty_concepts: list[UUID]
    contradictions: list[ContradictionResponse]


@router.get("")
async def lint(
    brain_id: UUID = Path(...),
    session: AsyncSession = Depends(get_session),
    _auth: None = Depends(require_brain_member),
) -> LintReportResponse:
    report = await build_lint_report(session, brain_id)
    return LintReportResponse(
        research_suggestions=[
            ResearchSuggestionResponse(
                topic=s.topic,
                mentioned_in=s.mentioned_in,
                usage_count=s.usage_count,
            )
            for s in report.research_suggestions
        ],
        orphans=[
            OrphanResponse(slug=o.slug, canonical_label=o.canonical_label)
            for o in report.orphans
        ],
        dirty_concepts=report.dirty_concepts,
        contradictions=[],
    )
