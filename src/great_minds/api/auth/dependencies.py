"""FastAPI auth dependencies."""

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.api.auth.models import User
from great_minds.api.auth.repository import get_user_by_id, resolve_api_key
from great_minds.api.auth.service import decode_access_token
from great_minds.api.db import get_session
from great_minds.api.settings import Settings, get_settings

bearer_scheme = HTTPBearer()


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
