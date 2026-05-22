"""Lint route — detection-only, on-demand.

Runs a handful of indexed DB queries per request and returns a report.
Frontend polls this endpoint via useExploreBadge; the Explore page
surfaces findings as automatic notifications (no "run lint" button).

Shape reflects the topic-based architecture directly:
- orphans: rendered articles with no incoming backlinks
- dirty_topics: topic_ids whose rendered output lags behind current
  compiled_from_hash
- unmentioned_links: topic_links (reduce's intent) edges with no
  matching backlink in the rendered prose
"""

from uuid import UUID

from fastapi import APIRouter

from great_minds.app.api.dependencies import SessionDep
from great_minds.core.lint import LintReport, build_lint_report

router = APIRouter(prefix="/lint", tags=["lint"])


@router.get("")
async def lint(
    vault_id: UUID,
    session: SessionDep,
) -> LintReport:
    return await build_lint_report(session, vault_id)
