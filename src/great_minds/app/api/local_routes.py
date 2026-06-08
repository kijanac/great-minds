"""Local-first desktop bootstrap routes."""

from fastapi import APIRouter, HTTPException, status

from great_minds.app.api.dependencies import (
    AuthServiceDep,
    SettingsDep,
    VaultServiceDep,
)
from great_minds.core.auth.schemas import TokenPair

router = APIRouter(prefix="/local", tags=["local"])


@router.post("/bootstrap")
async def bootstrap_local(
    auth_service: AuthServiceDep,
    vault_service: VaultServiceDep,
    settings: SettingsDep,
) -> TokenPair:
    """Create/get the local desktop user + default vault and mint tokens.

    This endpoint is intentionally available only when LOCAL_MODE=true and the
    backend is using local vault storage. It is the target desktop startup path:
    no email/code ceremony for an app-owned local workspace.
    """
    if not settings.local_mode or settings.storage_backend != "local":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")

    try:
        token_pair = await auth_service.bootstrap_local()
        await vault_service.ensure_default_for_user(
            token_pair.access_token,
            "local@great-minds.local",
            default_name="My Library",
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return token_pair
