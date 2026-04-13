"""FastAPI dependencies: auth and service factories."""

from uuid import UUID

from absurd_sdk import AsyncAbsurd
from fastapi import Depends, HTTPException, Path, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.core.auth.repository import AuthRepository
from great_minds.core.documents.repository import DocumentRepository
from great_minds.core.documents.service import DocumentService
from great_minds.core.ingest_service import IngestService
from great_minds.core.auth.service import AuthService
from great_minds.core.mail import Mailer
from great_minds.core.brains.repository import BrainRepository
from great_minds.core.brains.service import BrainService
from great_minds.core.crypto import decode_access_token
from great_minds.core.db import get_session
from great_minds.core.proposals.repository import ProposalRepository
from great_minds.core.proposals.service import ProposalService
from great_minds.core.settings import Settings, get_settings
from great_minds.core.tasks.repository import TaskRepository
from great_minds.core.tasks.service import TaskService
from great_minds.core.storage import Storage
from great_minds.core.users.models import User
from great_minds.core.users.repository import UserRepository
from great_minds.core.users.service import UserService

bearer_scheme = HTTPBearer()


# ---------------------------------------------------------------------------
# Repositories
# ---------------------------------------------------------------------------


def get_auth_repository(session: AsyncSession = Depends(get_session)) -> AuthRepository:
    return AuthRepository(session)


def get_user_repository(session: AsyncSession = Depends(get_session)) -> UserRepository:
    return UserRepository(session)


def get_brain_repository(
    session: AsyncSession = Depends(get_session),
) -> BrainRepository:
    return BrainRepository(session)


def get_document_repository(
    session: AsyncSession = Depends(get_session),
) -> DocumentRepository:
    return DocumentRepository(session)


def get_document_service(
    repo: DocumentRepository = Depends(get_document_repository),
) -> DocumentService:
    return DocumentService(repo)


def get_ingest_service(
    doc_service: DocumentService = Depends(get_document_service),
) -> IngestService:
    return IngestService(doc_service)


# ---------------------------------------------------------------------------
# Services
# ---------------------------------------------------------------------------


def get_brain_service(
    repo: BrainRepository = Depends(get_brain_repository),
    settings: Settings = Depends(get_settings),
) -> BrainService:
    return BrainService(repo, settings)


def get_user_service(
    user_repo: UserRepository = Depends(get_user_repository),
    brain_service: BrainService = Depends(get_brain_service),
) -> UserService:
    return UserService(user_repo, brain_service)


def get_mailer(settings: Settings = Depends(get_settings)) -> Mailer:
    return Mailer(settings)


def get_auth_service(
    auth_repo: AuthRepository = Depends(get_auth_repository),
    user_service: UserService = Depends(get_user_service),
    mailer: Mailer = Depends(get_mailer),
    settings: Settings = Depends(get_settings),
) -> AuthService:
    return AuthService(auth_repo, user_service, mailer, settings)


def get_proposal_repository(
    session: AsyncSession = Depends(get_session),
) -> ProposalRepository:
    return ProposalRepository(session)


def get_proposal_service(
    repo: ProposalRepository = Depends(get_proposal_repository),
    settings: Settings = Depends(get_settings),
) -> ProposalService:
    return ProposalService(repo, settings)


def get_absurd(request: Request) -> AsyncAbsurd:
    return request.app.state.absurd


def get_task_repository(
    session: AsyncSession = Depends(get_session),
) -> TaskRepository:
    return TaskRepository(session)


def get_task_service(
    repo: TaskRepository = Depends(get_task_repository),
    absurd: AsyncAbsurd = Depends(get_absurd),
) -> TaskService:
    return TaskService(repo, absurd)


def require_llm(settings: Settings = Depends(get_settings)) -> None:
    """Gate endpoints that need OpenRouter. Returns 503 if not configured."""
    if not settings.openrouter_api_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="LLM service not configured (OPENROUTER_API_KEY missing)",
        )


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------


async def get_current_user(
    request: Request,
    credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme),
    auth_repo: AuthRepository = Depends(get_auth_repository),
    user_repo: UserRepository = Depends(get_user_repository),
    settings: Settings = Depends(get_settings),
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


# ---------------------------------------------------------------------------
# Brain-scoped dependencies (path-based)
# ---------------------------------------------------------------------------


async def require_brain_member(
    brain_id: UUID = Path(...),
    user: User = Depends(get_current_user),
    brain_service: BrainService = Depends(get_brain_service),
) -> None:
    """Raises 403 if user is not a member of this brain."""
    if not await brain_service.is_member(brain_id, user.id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not a member of this brain",
        )


async def require_brain_owner(
    brain_id: UUID = Path(...),
    user: User = Depends(get_current_user),
    brain_service: BrainService = Depends(get_brain_service),
) -> None:
    """Raises 403 if user is not the brain owner."""
    try:
        await brain_service.require_owner(brain_id, user.id)
    except PermissionError as e:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=str(e),
        )


async def get_brain_storage(
    brain_id: UUID = Path(...),
    brain_service: BrainService = Depends(get_brain_service),
    _auth: None = Depends(require_brain_member),
) -> Storage:
    return brain_service.get_storage_by_id(brain_id)
