"""Auth API routes."""

import logging
import secrets
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.app.api.dependencies import get_current_user
from great_minds.app.api.schemas import auth as schemas
from great_minds.core.auth import repository as auth_repo
from great_minds.core.auth.models import ApiKey
from great_minds.core.auth.service import send_auth_code
from great_minds.core.crypto import create_access_token, create_refresh_token_value, generate_auth_code, hash_api_key
from great_minds.core.db import get_session
from great_minds.core.settings import Settings, get_settings
from great_minds.core.users.models import User
from great_minds.core.users.repository import get_or_create_user
from great_minds.core.users.service import provision_new_user

log = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/request-code", status_code=status.HTTP_202_ACCEPTED)
async def request_code(
    req: schemas.RequestCode,
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> dict:
    code = generate_auth_code()
    await auth_repo.store_auth_code(session, req.email, code, settings)
    await session.commit()
    send_auth_code(req.email, code, settings)
    return {"detail": "Code sent"}


@router.post("/verify-code", response_model=schemas.TokenPair)
async def verify_code(
    req: schemas.VerifyCode,
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> schemas.TokenPair:
    valid = await auth_repo.verify_auth_code(session, req.email, req.code)
    if not valid:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired code")

    user, created = await get_or_create_user(session, req.email)
    if created:
        await provision_new_user(session, user)

    access_token = create_access_token(user.id, settings)
    raw_refresh = create_refresh_token_value()
    await auth_repo.store_refresh_token(session, user.id, raw_refresh, settings)
    await session.commit()

    return schemas.TokenPair(access_token=access_token, refresh_token=raw_refresh)


@router.post("/refresh", response_model=schemas.TokenPair)
async def refresh(
    req: schemas.RefreshRequest,
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> schemas.TokenPair:
    rt = await auth_repo.validate_refresh_token(session, req.refresh_token)
    if rt is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired refresh token")

    rt.revoked = True
    access_token = create_access_token(rt.user_id, settings)
    raw_refresh = create_refresh_token_value()
    await auth_repo.store_refresh_token(session, rt.user_id, raw_refresh, settings)
    await session.commit()

    return schemas.TokenPair(access_token=access_token, refresh_token=raw_refresh)


@router.post("/api-keys", response_model=schemas.ApiKeyCreated, status_code=status.HTTP_201_CREATED)
async def create_api_key(
    req: schemas.ApiKeyCreate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> schemas.ApiKeyCreated:
    raw_key = f"gm_{secrets.token_urlsafe(32)}"
    api_key = ApiKey(
        user_id=user.id,
        key_hash=hash_api_key(raw_key),
        label=req.label,
    )
    session.add(api_key)
    await session.commit()
    await session.refresh(api_key)

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
) -> None:
    api_key = await session.get(ApiKey, key_id)
    if api_key is None or api_key.user_id != user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="API key not found")
    api_key.revoked = True
    await session.commit()
