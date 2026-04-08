"""Auth API routes."""

import logging
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.app.api.dependencies import get_auth_service, get_current_user
from great_minds.app.api.schemas import auth as schemas
from great_minds.core.auth.service import AuthService
from great_minds.core.db import get_session
from great_minds.core.users.models import User

log = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/request-code", status_code=status.HTTP_202_ACCEPTED)
async def request_code(
    req: schemas.RequestCode,
    session: AsyncSession = Depends(get_session),
    auth_service: AuthService = Depends(get_auth_service),
) -> dict:
    await auth_service.request_code(req.email)
    await session.commit()
    return {"detail": "Code sent"}


@router.post("/verify-code", response_model=schemas.TokenPair)
async def verify_code(
    req: schemas.VerifyCode,
    session: AsyncSession = Depends(get_session),
    auth_service: AuthService = Depends(get_auth_service),
) -> schemas.TokenPair:
    try:
        access_token, refresh_token = await auth_service.verify_code(
            req.email, req.code
        )
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired code"
        )
    await session.commit()
    return schemas.TokenPair(access_token=access_token, refresh_token=refresh_token)


@router.post("/refresh", response_model=schemas.TokenPair)
async def refresh(
    req: schemas.RefreshRequest,
    session: AsyncSession = Depends(get_session),
    auth_service: AuthService = Depends(get_auth_service),
) -> schemas.TokenPair:
    try:
        access_token, refresh_token = await auth_service.refresh_tokens(
            req.refresh_token
        )
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired refresh token",
        )
    await session.commit()
    return schemas.TokenPair(access_token=access_token, refresh_token=refresh_token)


@router.post(
    "/api-keys",
    response_model=schemas.ApiKeyCreated,
    status_code=status.HTTP_201_CREATED,
)
async def create_api_key(
    req: schemas.ApiKeyCreate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
    auth_service: AuthService = Depends(get_auth_service),
) -> schemas.ApiKeyCreated:
    api_key, raw_key = await auth_service.create_api_key(user.id, req.label)
    await session.commit()
    return schemas.ApiKeyCreated(
        id=api_key.id,
        label=api_key.label,
        revoked=api_key.revoked,
        created_at=api_key.created_at,
        raw_key=raw_key,
    )


@router.delete("/api-keys/{key_id}", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_api_key(
    key_id: UUID,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
    auth_service: AuthService = Depends(get_auth_service),
) -> None:
    try:
        await auth_service.revoke_api_key(key_id, user.id)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="API key not found"
        )
    await session.commit()
