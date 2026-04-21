"""Lint route — stubbed during the seven-phase refactor.

Lint remains a detection-only on-demand endpoint per the target
architecture, but the queries it runs depend on post-compile state
(topic_links vs backlinks divergence, orphan topics, etc.) that doesn't
exist yet. Returns an empty report until verify + publish are wired.
"""

from uuid import UUID

from fastapi import APIRouter, Depends, Path
from pydantic import BaseModel

from great_minds.app.api.dependencies import require_brain_member

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
    dirty_topics: list[UUID]
    contradictions: list[ContradictionResponse]


@router.get("")
async def lint(
    brain_id: UUID = Path(...),
    _auth: None = Depends(require_brain_member),
) -> LintReportResponse:
    return LintReportResponse(
        research_suggestions=[],
        orphans=[],
        dirty_topics=[],
        contradictions=[],
    )
