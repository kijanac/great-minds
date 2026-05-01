"""Auth API routes."""

import logging
from uuid import UUID

from fastapi import APIRouter, HTTPException, status

from great_minds.app.api.dependencies import (
    AuthServiceDep,
    BrainServiceDep,
    CurrentUser,
)
from great_minds.app.api.schemas import auth as schemas

log = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/request-code", status_code=status.HTTP_204_NO_CONTENT)
async def request_code(
    req: schemas.RequestCode,
    auth_service: AuthServiceDep,
) -> None:
    await auth_service.request_code(req.email)


@router.post("/verify-code")
async def verify_code(
    req: schemas.VerifyCode,
    auth_service: AuthServiceDep,
    brain_service: BrainServiceDep,
) -> schemas.TokenPair:
    try:
        user_id, access_token, refresh_token = await auth_service.verify_code(
            req.email, req.code
        )
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired code"
        )
    await brain_service.ensure_default_for_user(user_id, req.email)
    return schemas.TokenPair(access_token=access_token, refresh_token=refresh_token)


@router.post("/refresh")
async def refresh(
    req: schemas.RefreshRequest,
    auth_service: AuthServiceDep,
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
    return schemas.TokenPair(access_token=access_token, refresh_token=refresh_token)


@router.post(
    "/api-keys",
    status_code=status.HTTP_201_CREATED,
)
async def create_api_key(
    req: schemas.ApiKeyCreate,
    user: CurrentUser,
    auth_service: AuthServiceDep,
) -> schemas.ApiKeyCreated:
    api_key, raw_key = await auth_service.create_api_key(user.id, req.label)
    return schemas.ApiKeyCreated(
        id=api_key.id,
        label=api_key.label,
        revoked=api_key.revoked,
        created_at=api_key.created_at,
        raw_key=raw_key,
    )


@router.get("/api-keys")
async def list_api_keys(
    user: CurrentUser,
    auth_service: AuthServiceDep,
) -> list[schemas.ApiKey]:
    rows = await auth_service.list_api_keys(user.id)
    return [schemas.ApiKey.model_validate(k) for k in rows]


@router.delete("/api-keys/{key_id}", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_api_key(
    key_id: UUID,
    user: CurrentUser,
    auth_service: AuthServiceDep,
) -> None:
    try:
        await auth_service.revoke_api_key(key_id, user.id)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="API key not found"
        )
