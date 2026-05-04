"""FastAPI dependencies: auth and service factories."""

from typing import Annotated
from uuid import UUID

from absurd_sdk import AsyncAbsurd
from fastapi import Depends, HTTPException, Query, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.core.auth import AuthRepository, AuthService
from great_minds.core.authz import Forbidden
from great_minds.core.vaults import VaultAccess, VaultRepository, VaultService
from great_minds.core.compile_intents import CompileIntentRepository
from great_minds.core.crypto import decode_access_token
from great_minds.core.documents import DocumentRepository, DocumentService
from great_minds.core.ingest_service import IngestService
from great_minds.core.llm_costs import LlmCostEventRepository, LlmCostService
from great_minds.core.mail import Mailer
from great_minds.core.pagination import PageParams
from great_minds.core.proposals import ProposalRepository, ProposalService
from great_minds.core.settings import Settings, get_settings
from great_minds.core.paths import PROPOSALS_DIR
from great_minds.core.storage import LocalStorage, Storage
from great_minds.core.tasks import TaskRepository, TaskService
from great_minds.core.users import User, UserRepository, UserService


async def get_session(request: Request) -> AsyncSession:
    """FastAPI dependency: yields a per-request DB session.

    The session maker is injected by the lifespan (server.py) into
    ``request.state`` — a shallow copy of the lifespan's yielded dict
    per the Starlette ASGI lifespan spec.
    """
    sm = request.state["session_maker"]
    async with sm() as session:
        yield session

bearer_scheme = HTTPBearer()


# ---------------------------------------------------------------------------
# Primitives
# ---------------------------------------------------------------------------

SessionDep = Annotated[AsyncSession, Depends(get_session)]
SettingsDep = Annotated[Settings, Depends(get_settings)]
BearerCredsDep = Annotated[HTTPAuthorizationCredentials, Depends(bearer_scheme)]


def get_page_params(
    limit: Annotated[int, Query(ge=0, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> PageParams:
    return PageParams(limit=limit, offset=offset)


PageParamsQuery = Annotated[PageParams, Depends(get_page_params)]


# ---------------------------------------------------------------------------
# Repositories
# ---------------------------------------------------------------------------


def get_auth_repository(session: SessionDep) -> AuthRepository:
    return AuthRepository(session)


AuthRepositoryDep = Annotated[AuthRepository, Depends(get_auth_repository)]


def get_user_repository(session: SessionDep) -> UserRepository:
    return UserRepository(session)


UserRepositoryDep = Annotated[UserRepository, Depends(get_user_repository)]


def get_vault_repository(session: SessionDep) -> VaultRepository:
    return VaultRepository(session)


VaultRepositoryDep = Annotated[VaultRepository, Depends(get_vault_repository)]


def get_document_repository(session: SessionDep) -> DocumentRepository:
    return DocumentRepository(session)


DocumentRepositoryDep = Annotated[DocumentRepository, Depends(get_document_repository)]


def get_proposal_repository(session: SessionDep) -> ProposalRepository:
    return ProposalRepository(session)


ProposalRepositoryDep = Annotated[ProposalRepository, Depends(get_proposal_repository)]


def get_task_repository(session: SessionDep) -> TaskRepository:
    return TaskRepository(session)


TaskRepositoryDep = Annotated[TaskRepository, Depends(get_task_repository)]


def get_compile_intent_repository(session: SessionDep) -> CompileIntentRepository:
    return CompileIntentRepository(session)


CompileIntentRepositoryDep = Annotated[
    CompileIntentRepository, Depends(get_compile_intent_repository)
]


# ---------------------------------------------------------------------------
# Services
# ---------------------------------------------------------------------------


def get_document_service(repo: DocumentRepositoryDep) -> DocumentService:
    return DocumentService(repo)


DocumentServiceDep = Annotated[DocumentService, Depends(get_document_service)]


def get_llm_cost_service(session: SessionDep) -> LlmCostService:
    return LlmCostService(LlmCostEventRepository(session))


LlmCostServiceDep = Annotated[LlmCostService, Depends(get_llm_cost_service)]


def get_ingest_service(doc_service: DocumentServiceDep) -> IngestService:
    return IngestService(doc_service)


IngestServiceDep = Annotated[IngestService, Depends(get_ingest_service)]


def get_vault_service(
    repo: VaultRepositoryDep,
    user_repo: UserRepositoryDep,
    settings: SettingsDep,
) -> VaultService:
    return VaultService(repo, user_repo, settings)


VaultServiceDep = Annotated[VaultService, Depends(get_vault_service)]


def get_user_service(
    user_repo: UserRepositoryDep,
    vault_service: VaultServiceDep,
    settings: SettingsDep,
) -> UserService:
    return UserService(user_repo, vault_service, settings)


UserServiceDep = Annotated[UserService, Depends(get_user_service)]


def get_mailer(settings: SettingsDep) -> Mailer:
    return Mailer(settings)


MailerDep = Annotated[Mailer, Depends(get_mailer)]


def get_auth_service(
    auth_repo: AuthRepositoryDep,
    user_service: UserServiceDep,
    mailer: MailerDep,
    settings: SettingsDep,
) -> AuthService:
    return AuthService(auth_repo, user_service, mailer, settings)


AuthServiceDep = Annotated[AuthService, Depends(get_auth_service)]


def get_proposals_storage(settings: SettingsDep) -> LocalStorage:
    return LocalStorage(f"{settings.data_dir}/{PROPOSALS_DIR}")


ProposalsStorageDep = Annotated[LocalStorage, Depends(get_proposals_storage)]


def get_proposal_service(
    repo: ProposalRepositoryDep,
    doc_service: DocumentServiceDep,
    proposals_storage: ProposalsStorageDep,
) -> ProposalService:
    return ProposalService(repo, doc_service, proposals_storage)


ProposalServiceDep = Annotated[ProposalService, Depends(get_proposal_service)]


def get_absurd(request: Request) -> AsyncAbsurd:
    return request.app.state.absurd


AbsurdDep = Annotated[AsyncAbsurd, Depends(get_absurd)]


def get_task_service(
    repo: TaskRepositoryDep,
    absurd: AbsurdDep,
) -> TaskService:
    return TaskService(repo, absurd)


TaskServiceDep = Annotated[TaskService, Depends(get_task_service)]


def require_llm(settings: SettingsDep) -> None:
    """Gate endpoints that need OpenRouter. Returns 503 if not configured."""
    if not settings.openrouter_api_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="LLM service not configured (OPENROUTER_API_KEY missing)",
        )


LlmGuard = Annotated[None, Depends(require_llm)]


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------


async def get_current_user(
    request: Request,
    credentials: BearerCredsDep,
    auth_repo: AuthRepositoryDep,
    user_repo: UserRepositoryDep,
    settings: SettingsDep,
) -> User:
    token = credentials.credentials

    # Try JWT first
    try:
        user_id = decode_access_token(token, settings)
        user = await user_repo.get_by_id(user_id)
        if user is not None:
            request.state.user_id = user.id
            return user
    except ValueError:
        pass

    # Fall back to API key
    user = await auth_repo.resolve_api_key(token)
    if user is not None:
        request.state.user_id = user.id
        return user

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials"
    )


CurrentUser = Annotated[User, Depends(get_current_user)]


# ---------------------------------------------------------------------------
# Vault-scoped dependencies (path-based)
# ---------------------------------------------------------------------------


def get_vault_access(repo: VaultRepositoryDep) -> VaultAccess:
    return VaultAccess(repo)


VaultAccessDep = Annotated[VaultAccess, Depends(get_vault_access)]


async def require_vault_member(
    vault_id: UUID,
    user: CurrentUser,
    access: VaultAccessDep,
) -> None:
    """Raises 403 if user is not a member of this vault."""
    try:
        await access.require_member(vault_id, user.id)
    except Forbidden:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only vault members can perform this action",
        )


async def require_vault_owner(
    vault_id: UUID,
    user: CurrentUser,
    access: VaultAccessDep,
) -> None:
    """Raises 403 if user is not the vault owner."""
    try:
        await access.require_owner(vault_id, user.id)
    except Forbidden:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only vault owners can perform this action",
        )


VaultMemberGuard = Annotated[None, Depends(require_vault_member)]
VaultOwnerGuard = Annotated[None, Depends(require_vault_owner)]


async def get_vault_storage(
    vault_id: UUID,
    vault_service: VaultServiceDep,
    _auth: VaultMemberGuard,
) -> Storage:
    return await vault_service.get_storage_by_id(vault_id)


VaultStorageDep = Annotated[Storage, Depends(get_vault_storage)]
