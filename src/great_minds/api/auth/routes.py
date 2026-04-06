"""Auth API routes."""

import logging
import secrets
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.api.auth import repository, schemas, service
from great_minds.api.auth.dependencies import get_current_user
from great_minds.api.auth.models import ApiKey, User
from great_minds.api.db import get_session
from great_minds.api.settings import Settings, get_settings

log = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/request-code", status_code=status.HTTP_202_ACCEPTED)
async def request_code(
    req: schemas.RequestCode,
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> dict:
    code = service.generate_auth_code()
    await repository.store_auth_code(session, req.email, code, settings)
    await session.commit()
    service.send_auth_code(req.email, code, settings)
    return {"detail": "Code sent"}


@router.post("/verify-code", response_model=schemas.TokenPair)
async def verify_code(
    req: schemas.VerifyCode,
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> schemas.TokenPair:
    valid = await repository.verify_auth_code(session, req.email, req.code)
    if not valid:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired code")

    user, created = await repository.get_or_create_user(session, req.email)
    if created:
        await service.provision_new_user(session, user)

    access_token = service.create_access_token(user.id, settings)
    raw_refresh = service.create_refresh_token_value()
    await repository.store_refresh_token(session, user.id, raw_refresh, settings)
    await session.commit()

    return schemas.TokenPair(access_token=access_token, refresh_token=raw_refresh)


@router.post("/refresh", response_model=schemas.TokenPair)
async def refresh(
    req: schemas.RefreshRequest,
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> schemas.TokenPair:
    rt = await repository.validate_refresh_token(session, req.refresh_token)
    if rt is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired refresh token")

    rt.revoked = True
    access_token = service.create_access_token(rt.user_id, settings)
    raw_refresh = service.create_refresh_token_value()
    await repository.store_refresh_token(session, rt.user_id, raw_refresh, settings)
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
        key_hash=service.hash_api_key(raw_key),
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
