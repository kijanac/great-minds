"""FastAPI dependencies: auth and service factories."""

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.core.auth.repository import resolve_api_key
from great_minds.core.brains.service import BrainService
from great_minds.core.crypto import decode_access_token
from great_minds.core.db import get_session
from great_minds.core.proposals.service import ProposalService
from great_minds.core.settings import Settings, get_settings
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


def get_brain_service() -> BrainService:
    return BrainService()


def get_proposal_service(
    brain_service: BrainService = Depends(get_brain_service),
) -> ProposalService:
    return ProposalService(brain_service)
