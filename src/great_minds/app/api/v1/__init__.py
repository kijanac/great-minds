"""v1 API router — aggregates all domain routers."""

from fastapi import APIRouter, Depends

from great_minds.app.api.auth_routes import router as auth_router
from great_minds.app.api.vault_routes import router as vault_router
from great_minds.app.api.compile_routes import router as compile_router
from great_minds.app.api.cost_routes import router as cost_router
from great_minds.app.api.dependencies import require_vault_member
from great_minds.app.api.ingest_routes import router as ingest_router
from great_minds.app.api.lint_routes import router as lint_router
from great_minds.app.api.proposal_routes import router as proposal_router
from great_minds.app.api.query_routes import router as query_router
from great_minds.app.api.session_routes import router as session_router
from great_minds.app.api.task_routes import router as task_router
from great_minds.app.api.wiki_routes import router as wiki_router

router = APIRouter(prefix="/v1")

# Non-vault-scoped routes
router.include_router(auth_router)
router.include_router(vault_router)
router.include_router(cost_router)

# Vault-scoped routes — nested under /v1/vaults/{vault_id}/. Membership is
# enforced once at the router level; owner-only routes layer VaultOwnerGuard
# on top.
vault_scoped = APIRouter(
    prefix="/vaults/{vault_id}",
    dependencies=[Depends(require_vault_member)],
)
vault_scoped.include_router(compile_router)
vault_scoped.include_router(ingest_router)
vault_scoped.include_router(lint_router)
vault_scoped.include_router(query_router)
vault_scoped.include_router(session_router)
vault_scoped.include_router(task_router)
vault_scoped.include_router(wiki_router)
vault_scoped.include_router(proposal_router)
router.include_router(vault_scoped)
