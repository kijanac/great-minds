"""Auth API routes."""

import logging
from uuid import UUID

from fastapi import APIRouter, HTTPException, status

from great_minds.app.api.dependencies import (
    AuthServiceDep,
    VaultServiceDep,
    CurrentUser,
    UserServiceDep,
)
from great_minds.app.api.schemas import auth as schemas
from great_minds.core.auth.schemas import ApiKey, ApiKeyWithSecret, TokenPair

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
    vault_service: VaultServiceDep,
) -> TokenPair:
    try:
        token_pair = await auth_service.verify_code(req.email, req.code)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired code"
        )
    await vault_service.ensure_default_for_user(token_pair.access_token, req.email)
    return token_pair


@router.post("/refresh")
async def refresh(
    req: schemas.RefreshRequest,
    auth_service: AuthServiceDep,
) -> TokenPair:
    try:
        return await auth_service.refresh_tokens(req.refresh_token)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired refresh token",
        )


@router.post(
    "/api-keys",
    status_code=status.HTTP_201_CREATED,
)
async def create_api_key(
    req: schemas.ApiKeyCreate,
    user: CurrentUser,
    auth_service: AuthServiceDep,
) -> ApiKeyWithSecret:
    return await auth_service.create_api_key(user.id, req.label)


@router.get("/api-keys")
async def list_api_keys(
    user: CurrentUser,
    auth_service: AuthServiceDep,
) -> list[ApiKey]:
    rows = await auth_service.list_api_keys(user.id)
    return [ApiKey.model_validate(k) for k in rows]


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


@router.delete("/me", status_code=status.HTTP_204_NO_CONTENT)
async def delete_account(
    req: schemas.AccountDeleteRequest,
    user: CurrentUser,
    user_service: UserServiceDep,
) -> None:
    """Self-service account deletion.

    Drops every vault the user owns (and its R2 prefix), the user row
    (cascading api_keys, refresh_tokens, vault memberships), and the
    user's R2 bucket if any. Vaults where the user is only a member are
    left in place; the membership cascades away with the user row.
    Requires ``{"confirm": "DELETE"}`` in the body.
    """
    log.info("account_delete_requested user_id=%s", user.id)
    await user_service.delete_self(user.id)
