"""Brain CRUD and membership routes."""

import logging
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status

from great_minds.app.api.dependencies import (
    get_brain_service,
    get_current_user,
    get_mailer,
    get_user_service,
    require_brain_owner,
)
from great_minds.app.api.schemas import brains as schemas
from great_minds.core import brain as brain_ops
from great_minds.core.brains.service import BrainService
from great_minds.core.mail import Mailer
from great_minds.core.users.models import User
from great_minds.core.users.service import UserService

log = logging.getLogger(__name__)

router = APIRouter(prefix="/brains", tags=["brains"])


@router.get("")
async def list_brains(
    user: User = Depends(get_current_user),
    brain_service: BrainService = Depends(get_brain_service),
) -> list[schemas.BrainOverview]:
    rows = await brain_service.list_brains(user.id)
    return [
        schemas.BrainOverview(id=brain.id, name=brain.name, role=role)
        for brain, role in rows
    ]


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_brain(
    req: schemas.BrainCreate,
    user: User = Depends(get_current_user),
    brain_service: BrainService = Depends(get_brain_service),
) -> schemas.Brain:
    brain, role = await brain_service.create_brain(req.name, user.id)
    return schemas.Brain(
        id=brain.id,
        name=brain.name,
        role=role,
        owner_id=brain.owner_id,
        created_at=brain.created_at,
    )


@router.get("/{brain_id}")
async def get_brain(
    brain_id: UUID,
    user: User = Depends(get_current_user),
    brain_service: BrainService = Depends(get_brain_service),
) -> schemas.BrainDetail:
    try:
        brain, role = await brain_service.get_brain(brain_id, user.id)
    except ValueError:
        raise HTTPException(status_code=404, detail="Brain not found")

    member_count = await brain_service.get_member_count(brain.id)
    storage = brain_service.get_storage(brain)
    article_count = len(brain_ops.list_articles(storage))

    return schemas.BrainDetail(
        id=brain.id,
        name=brain.name,
        role=role,
        owner_id=brain.owner_id,
        created_at=brain.created_at,
        member_count=member_count,
        article_count=article_count,
    )


@router.get("/{brain_id}/members")
async def list_members(
    brain_id: UUID,
    user: User = Depends(get_current_user),
    brain_service: BrainService = Depends(get_brain_service),
) -> list[schemas.MembershipOverview]:
    try:
        await brain_service.get_brain(brain_id, user.id)
    except ValueError:
        raise HTTPException(status_code=404, detail="Brain not found")

    rows = await brain_service.list_members(brain_id)
    return [
        schemas.MembershipOverview(user_id=m.user_id, email=email, role=m.role)
        for m, email in rows
    ]


@router.post("/{brain_id}/members", status_code=status.HTTP_201_CREATED)
async def invite_member(
    req: schemas.MembershipInvite,
    brain_id: UUID,
    user: User = Depends(get_current_user),
    brain_service: BrainService = Depends(get_brain_service),
    user_service: UserService = Depends(get_user_service),
    mailer: Mailer = Depends(get_mailer),
    _auth: None = Depends(require_brain_owner),
) -> schemas.MembershipOverview:
    brain = await brain_service.get_by_id(brain_id)

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

    return schemas.MembershipOverview(
        user_id=target_user.id, email=target_user.email, role=req.role
    )


@router.put("/{brain_id}/members/{member_user_id}")
async def set_member(
    member_user_id: UUID,
    req: schemas.MembershipUpdate,
    brain_id: UUID,
    brain_service: BrainService = Depends(get_brain_service),
    user_service: UserService = Depends(get_user_service),
    _auth: None = Depends(require_brain_owner),
) -> schemas.MembershipOverview:
    target_user = await user_service.get_by_id(member_user_id)
    if target_user is None:
        raise HTTPException(status_code=404, detail="User not found")

    await brain_service.upsert_membership(brain_id, member_user_id, req.role)

    return schemas.MembershipOverview(
        user_id=target_user.id, email=target_user.email, role=req.role
    )


@router.delete(
    "/{brain_id}/members/{member_user_id}", status_code=status.HTTP_204_NO_CONTENT
)
async def remove_member(
    member_user_id: UUID,
    brain_id: UUID,
    brain_service: BrainService = Depends(get_brain_service),
    _auth: None = Depends(require_brain_owner),
) -> None:
    deleted = await brain_service.delete_membership(brain_id, member_user_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Membership not found")
