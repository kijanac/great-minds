"""Lint routes — reads pre-computed results from brain storage.

Lint runs automatically as a post-compile side effect (see workers.py).
"""

import json

from fastapi import APIRouter, Depends

from great_minds.app.api.dependencies import get_brain_storage
from great_minds.core.linter import (
    LINT_STORAGE_PATH,
    LintCountsResponse,
    LintResponse,
)
from great_minds.core.storage import Storage

router = APIRouter(prefix="/lint", tags=["lint"])


@router.get("")
async def lint(
    storage: Storage = Depends(get_brain_storage),
) -> LintResponse:
    raw = storage.read(LINT_STORAGE_PATH, strict=False)
    if raw is None:
        return LintResponse(
            fixes_applied=[],
            remaining_issues=0,
            counts=LintCountsResponse(
                dead_links=0,
                broken_citations=0,
                orphans=0,
                uncompiled=0,
                uncited=0,
                missing_index=0,
                tag_issues=0,
            ),
        )
    return LintResponse.model_validate(json.loads(raw))
