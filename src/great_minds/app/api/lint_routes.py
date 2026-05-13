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

from fastapi import APIRouter

from great_minds.app.api.dependencies import (
    VaultStorageDep,
    SessionDep,
)
from great_minds.core.lint import LintReport, build_lint_report

router = APIRouter(prefix="/lint", tags=["lint"])


@router.get("")
async def lint(
    vault_id: UUID,
    storage: VaultStorageDep,
    session: SessionDep,
) -> LintReport:
    return await build_lint_report(session, vault_id, storage)
