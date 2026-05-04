"""Vault CRUD and membership routes."""

import logging
from uuid import UUID

from fastapi import APIRouter, HTTPException, status

from great_minds.app.api.dependencies import (
    VaultAccessDep,
    VaultMemberGuard,
    VaultOwnerGuard,
    VaultServiceDep,
    CurrentUser,
    DocumentRepositoryDep,
    MailerDep,
    PageParamsQuery,
    UserServiceDep,
)
from great_minds.app.api.schemas import vaults as schemas
from great_minds.app.api.schemas.vaults import (
    VaultConfig,
    VaultDetail,
    VaultPage,
)
from great_minds.core.vaults.config import draft_thematic_hint, load_vault_config
from great_minds.core.vaults.models import MemberRole
from great_minds.core.vaults.schemas import (
    MemberWithEmail,
    MembershipInternal,
    Vault,
    VaultConfigUpdate,
    VaultCreate,
)
from great_minds.core.documents import DocKind
from great_minds.core.llm import get_async_client
from great_minds.core.pagination import Page

log = logging.getLogger(__name__)

router = APIRouter(prefix="/vaults", tags=["vaults"])


@router.get("")
async def list_vaults(
    pagination: PageParamsQuery,
    user: CurrentUser,
    vault_service: VaultServiceDep,
) -> VaultPage:
    result = await vault_service.list_vaults_page(user.id, pagination=pagination)
    return VaultPage(
        items=[vault for vault, _role in result.items],
        roles={str(vault.id): role for vault, role in result.items},
        pagination=result.pagination,
    )


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_vault(
    req: VaultCreate,
    user: CurrentUser,
    vault_service: VaultServiceDep,
) -> Vault:
    vault = await vault_service.create_vault(
        req.name,
        user.id,
        thematic_hint=req.thematic_hint,
        kinds=req.kinds,
    )
    return vault


@router.post("/draft-hint")
async def draft_hint(
    req: schemas.DraftHintRequest,
    _user: CurrentUser,
) -> schemas.DraftHintResponse:
    description = req.description.strip()
    if not description:
        raise HTTPException(status_code=400, detail="description required")
    hint = await draft_thematic_hint(get_async_client(), description)
    return schemas.DraftHintResponse(thematic_hint=hint)


@router.get("/{vault_id}")
async def get_vault(
    vault_id: UUID,
    user: CurrentUser,
    vault_service: VaultServiceDep,
    vault_access: VaultAccessDep,
    doc_repo: DocumentRepositoryDep,
) -> VaultDetail:
    try:
        vault = await vault_service.get_vault(vault_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="Vault not found")

    role = await vault_access.get_member_role(vault_id, user.id)
    if role is None:
        raise HTTPException(status_code=403, detail="Not a member of this vault")

    member_count = await vault_service.get_member_count(vault.id)
    article_count = await doc_repo.count_by_kind(vault.id, DocKind.WIKI)

    return VaultDetail(
        **vault.model_dump(),
        role=role,
        member_count=member_count,
        article_count=article_count,
    )


@router.get("/{vault_id}/config")
async def get_vault_config(
    vault_id: UUID,
    _auth: VaultMemberGuard,
    vault_service: VaultServiceDep,
) -> VaultConfig:
    try:
        vault = await vault_service.get_vault(vault_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="Vault not found")

    cfg = await load_vault_config(vault_service.get_storage(vault))
    return VaultConfig(
        thematic_hint=cfg.thematic_hint,
        kinds=list(cfg.kinds),
    )


@router.patch("/{vault_id}/config")
async def update_vault_config(
    vault_id: UUID,
    req: VaultConfigUpdate,
    user: CurrentUser,
    _auth: VaultOwnerGuard,
    vault_service: VaultServiceDep,
) -> VaultConfig:
    await vault_service.update_config(
        vault_id,
        thematic_hint=req.thematic_hint,
        kinds=req.kinds,
    )
    vault = await vault_service.get_vault(vault_id)
    cfg = await load_vault_config(vault_service.get_storage(vault))
    return VaultConfig(
        thematic_hint=cfg.thematic_hint,
        kinds=list(cfg.kinds),
    )


@router.get("/{vault_id}/members")
async def list_members(
    vault_id: UUID,
    pagination: PageParamsQuery,
    _auth: VaultOwnerGuard,
    vault_service: VaultServiceDep,
) -> Page[MemberWithEmail]:
    try:
        await vault_service.get_vault(vault_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="Vault not found")

    result = await vault_service.list_members_page(vault_id, pagination=pagination)
    return Page(
        items=list(result.items),
        pagination=result.pagination,
    )


@router.post("/{vault_id}/members", status_code=status.HTTP_201_CREATED)
async def invite_member(
    req: schemas.MembershipInvite,
    vault_id: UUID,
    user: CurrentUser,
    _auth: VaultOwnerGuard,
    vault_service: VaultServiceDep,
    user_service: UserServiceDep,
    mailer: MailerDep,
) -> MemberWithEmail:
    vault = await vault_service.get_vault(vault_id)

    target_user = await user_service.ensure_user(req.email)
    await vault_service.add_member(
        MembershipInternal(
            vault_id=vault_id, user_id=target_user.id, role=req.role
        )
    )

    await mailer.send(
        to=req.email,
        subject=f"You've been invited to {vault.name}",
        body=(
            f'{user.email} invited you to the project "{vault.name}" '
            f"on Great Minds as {req.role.value}.\n\n"
            f"Sign in at https://greatmind.dev to access it."
        ),
    )

    return MemberWithEmail(user_id=target_user.id, email=target_user.email, role=req.role)


@router.put("/{vault_id}/members/{member_user_id}")
async def set_member(
    member_user_id: UUID,
    req: schemas.MembershipUpdate,
    vault_id: UUID,
    _auth: VaultOwnerGuard,
    vault_service: VaultServiceDep,
    user_service: UserServiceDep,
) -> MemberWithEmail:
    target_user = await user_service.get_by_id(member_user_id)
    if target_user is None:
        raise HTTPException(status_code=404, detail="User not found")

    try:
        await vault_service.set_member_role(
            MembershipInternal(
                vault_id=vault_id, user_id=member_user_id, role=req.role
            )
        )
    except ValueError:
        raise HTTPException(
            status_code=404, detail="User is not a member of this vault"
        )

    return MemberWithEmail(user_id=target_user.id, email=target_user.email, role=req.role)


@router.delete(
    "/{vault_id}/members/{member_user_id}", status_code=status.HTTP_204_NO_CONTENT
)
async def remove_member(
    member_user_id: UUID,
    vault_id: UUID,
    _auth: VaultOwnerGuard,
    vault_service: VaultServiceDep,
) -> None:
    deleted = await vault_service.delete_membership(vault_id, member_user_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Membership not found")