"""FastAPI dependencies: auth and service factories."""

from dataclasses import dataclass
from pathlib import Path
from uuid import UUID

from absurd_sdk import AsyncAbsurd
from fastapi import Depends, HTTPException, Query, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.core.auth.repository import resolve_api_key
from great_minds.core.brains.models import MemberRole
from great_minds.core.brains.repository import BrainRepository
from great_minds.core.brains.schemas import Brain
from great_minds.core.brains.service import BrainService
from great_minds.core.crypto import decode_access_token
from great_minds.core.db import get_session
from great_minds.core.proposals.service import ProposalService
from great_minds.core.settings import Settings, get_settings
from great_minds.core.storage import LocalStorage, Storage
from great_minds.core.users.models import User
from great_minds.core.users.repository import get_user_by_id

bearer_scheme = HTTPBearer()


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------


async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> User:
    token = credentials.credentials

    # Try JWT first
    try:
        user_id = decode_access_token(token, settings)
        user = await get_user_by_id(session, user_id)
        if user is not None:
            return user
    except ValueError:
        pass

    # Fall back to API key
    user = await resolve_api_key(session, token)
    if user is not None:
        return user

    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")


# ---------------------------------------------------------------------------
# Service factories
# ---------------------------------------------------------------------------


def get_absurd(request: Request) -> AsyncAbsurd:
    return request.app.state.absurd


def get_brain_repository(session: AsyncSession = Depends(get_session)) -> BrainRepository:
    return BrainRepository(session)


def get_brain_service(repo: BrainRepository = Depends(get_brain_repository)) -> BrainService:
    return BrainService(repo)


def get_proposal_service() -> ProposalService:
    return ProposalService()


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
    storage = LocalStorage(Path(brain.storage_root))
    return BrainContext(brain=brain, storage=storage, role=role)
