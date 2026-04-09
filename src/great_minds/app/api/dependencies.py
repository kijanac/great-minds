"""FastAPI dependencies: auth and service factories."""

from dataclasses import dataclass
from uuid import UUID

from absurd_sdk import AsyncAbsurd
from fastapi import Depends, HTTPException, Query, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.core.auth.repository import AuthRepository
from great_minds.core.documents.repository import DocumentRepository
from great_minds.core.documents.service import DocumentService
from great_minds.core.auth.service import AuthService
from great_minds.core.mail import Mailer
from great_minds.core.brains.models import MemberRole
from great_minds.core.brains.repository import BrainRepository
from great_minds.core.brains.schemas import Brain
from great_minds.core.brains.service import BrainService
from great_minds.core.crypto import decode_access_token
from great_minds.core.db import get_session
from great_minds.core.proposals.service import ProposalService
from great_minds.core.settings import Settings, get_settings
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


def get_proposal_service(settings: Settings = Depends(get_settings)) -> ProposalService:
    return ProposalService(settings)


def get_absurd(request: Request) -> AsyncAbsurd:
    return request.app.state.absurd


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
            return user
    except ValueError:
        pass

    # Fall back to API key
    user = await auth_repo.resolve_api_key(token)
    if user is not None:
        return user

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials"
    )


# ---------------------------------------------------------------------------
# Brain context (auth + storage in one dependency)
# ---------------------------------------------------------------------------


@dataclass
class BrainContext:
    brain: Brain
    storage: Storage
    role: MemberRole


async def get_authorized_brain(
    brain_id: UUID = Query(...),
    user: User = Depends(get_current_user),
    brain_service: BrainService = Depends(get_brain_service),
) -> BrainContext:
    brain, role = await brain_service.get_brain(brain_id, user.id)
    storage = brain_service.get_storage(brain)
    return BrainContext(brain=brain, storage=storage, role=role)
