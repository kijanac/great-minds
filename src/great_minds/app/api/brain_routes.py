"""Brain CRUD and membership routes."""

import logging
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status

from great_minds.app.api.dependencies import (
    BrainMemberGuard,
    BrainOwnerGuard,
    CurrentUser,
    get_brain_access,
    get_brain_service,
    get_document_repository,
    get_mailer,
    get_user_service,
    PageParamsQuery,
)
from great_minds.app.api.schemas import brains as schemas
from great_minds.app.api.schemas.brains import (
    Brain,
    BrainConfigUpdate,
    BrainConfig,
    BrainCreate,
    BrainDetail,
    BrainOverview,
    Membership,
)
from great_minds.core.brain_config import draft_thematic_hint, load_brain_config
from great_minds.core.brains import BrainAccess, BrainService
from great_minds.core.documents import DocKind, DocumentRepository
from great_minds.core.llm import get_async_client
from great_minds.core.mail import Mailer
from great_minds.core.pagination import Page
from great_minds.core.users import UserService

log = logging.getLogger(__name__)

router = APIRouter(prefix="/brains", tags=["brains"])


@router.get("")
async def list_brains(
    pagination: PageParamsQuery,
    user: CurrentUser,
    brain_service: BrainService = Depends(get_brain_service),
) -> Page[BrainOverview]:
    result = await brain_service.list_brains_page(user.id, pagination=pagination)
    return Page(
        items=[
            BrainOverview(id=item.brain.id, name=item.brain.name, role=item.role)
            for item in result.items
        ],
        pagination=result.pagination,
    )


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_brain(
    req: BrainCreate,
    user: CurrentUser,
    brain_service: BrainService = Depends(get_brain_service),
) -> Brain:
    brain, role = await brain_service.create_brain(
        req.name,
        user.id,
        thematic_hint=req.thematic_hint,
        kinds=req.kinds,
    )
    return Brain(
        id=brain.id,
        name=brain.name,
        role=role,
        owner_id=brain.owner_id,
        created_at=brain.created_at,
    )


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


@router.get("/{brain_id}")
async def get_brain(
    brain_id: UUID,
    user: CurrentUser,
    brain_service: BrainService = Depends(get_brain_service),
    brain_access: BrainAccess = Depends(get_brain_access),
    doc_repo: DocumentRepository = Depends(get_document_repository),
) -> BrainDetail:
    try:
        brain = await brain_service.get_brain(brain_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="Brain not found")
    
    role = await brain_access.get_member_role(brain_id, user.id)
    if role is None:
        raise HTTPException(status_code=403, detail="Not a member of this brain")
        
    member_count = await brain_service.get_member_count(brain.id)
    article_count = await doc_repo.count_by_kind(brain.id, DocKind.WIKI)

    return BrainDetail(
        id=brain.id,
        name=brain.name,
        role=role,
        owner_id=brain.owner_id,
        created_at=brain.created_at,
        member_count=member_count,
        article_count=article_count,
    )


@router.get("/{brain_id}/config")
async def get_brain_config(
    brain_id: UUID,
    _auth: BrainMemberGuard,
    brain_service: BrainService = Depends(get_brain_service),
) -> BrainConfig:
    try:
        brain = await brain_service.get_brain(brain_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="Brain not found")
    
    cfg = await load_brain_config(brain_service.get_storage(brain))
    return BrainConfig(
        thematic_hint=cfg.thematic_hint,
        kinds=list(cfg.kinds),
    )


@router.patch("/{brain_id}/config")
async def update_brain_config(
    brain_id: UUID,
    req: BrainConfigUpdate,
    user: CurrentUser,
    _auth: BrainOwnerGuard,
    brain_service: BrainService = Depends(get_brain_service),
) -> BrainConfig:
    await brain_service.update_config(
        brain_id,
        thematic_hint=req.thematic_hint,
        kinds=req.kinds,
    )
    brain = await brain_service.get_brain(brain_id)
    cfg = await load_brain_config(brain_service.get_storage(brain))
    return BrainConfig(
        thematic_hint=cfg.thematic_hint,
        kinds=list(cfg.kinds),
    )


@router.get("/{brain_id}/members")
async def list_members(
    brain_id: UUID,
    pagination: PageParamsQuery,
    _auth: BrainOwnerGuard,
    brain_service: BrainService = Depends(get_brain_service),
) -> Page[Membership]:
    try:
        await brain_service.get_brain(brain_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="Brain not found")

    result = await brain_service.list_members_page(brain_id, pagination=pagination)
    return Page(
        items=[
            Membership(user_id=item.user_id, email=item.email, role=item.role)
            for item in result.items
        ],
        pagination=result.pagination,
    )


@router.post("/{brain_id}/members", status_code=status.HTTP_201_CREATED)
async def invite_member(
    req: schemas.MembershipInvite,
    brain_id: UUID,
    user: CurrentUser,
    _auth: BrainOwnerGuard,
    brain_service: BrainService = Depends(get_brain_service),
    user_service: UserService = Depends(get_user_service),
    mailer: Mailer = Depends(get_mailer),
) -> Membership:
    brain = await brain_service.get_brain(brain_id)

    target_user, _created = await user_service.get_or_create(req.email)
    await brain_service.upsert_membership(brain_id, target_user.id, req.role)

    await mailer.send(
        to=req.email,
        subject=f"You've been invited to {brain.name}",
        body=(
            f'{user.email} invited you to the project "{brain.name}" '
            f"on Great Minds as {req.role.value}.\n\n"
            f"Sign in at https://greatmind.dev to access it."
        ),
    )

    return Membership(
        user_id=target_user.id, email=target_user.email, role=req.role
    )


@router.put("/{brain_id}/members/{member_user_id}")
async def set_member(
    member_user_id: UUID,
    req: schemas.MembershipUpdate,
    brain_id: UUID,
    _auth: BrainOwnerGuard,
    brain_service: BrainService = Depends(get_brain_service),
    user_service: UserService = Depends(get_user_service),
) -> Membership:
    target_user = await user_service.get_by_id(member_user_id)
    if target_user is None:
        raise HTTPException(status_code=404, detail="User not found")

    await brain_service.upsert_membership(brain_id, member_user_id, req.role)

    return Membership(
        user_id=target_user.id, email=target_user.email, role=req.role
    )


@router.delete(
    "/{brain_id}/members/{member_user_id}", status_code=status.HTTP_204_NO_CONTENT
)
async def remove_member(
    member_user_id: UUID,
    brain_id: UUID,
    _auth: BrainOwnerGuard,
    brain_service: BrainService = Depends(get_brain_service),
) -> None:
    deleted = await brain_service.delete_membership(brain_id, member_user_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Membership not found")
