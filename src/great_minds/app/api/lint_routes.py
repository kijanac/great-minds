"""Lint routes."""

from fastapi import APIRouter, Depends

from great_minds.app.api.dependencies import get_brain_storage
from great_minds.app.api.schemas.lint import LintResponse
from great_minds.core import linter
from great_minds.core.storage import Storage

router = APIRouter(prefix="/lint", tags=["lint"])


@router.get("")
async def lint(
    deep: bool = False,
    storage: Storage = Depends(get_brain_storage),
) -> LintResponse:
    result = await linter.run_lint(storage, deep=deep)
    return LintResponse.model_validate(result, from_attributes=True)


@router.post("/fix")
async def lint_fix(
    deep: bool = False,
    storage: Storage = Depends(get_brain_storage),
) -> LintResponse:
    result = await linter.run_lint(storage, deep=deep, fix=True)
    return LintResponse.model_validate(result, from_attributes=True)
