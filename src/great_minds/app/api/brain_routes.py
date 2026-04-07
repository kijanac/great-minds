"""Brain CRUD and membership routes."""

import logging
from pathlib import Path
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.app.api.dependencies import get_brain_service, get_current_user
from great_minds.core.settings import Settings, get_settings
from great_minds.app.api.schemas import brains as schemas
from great_minds.core import brain as brain_ops
from great_minds.core.brains.models import MemberRole
from great_minds.core.brains.service import BrainService
from great_minds.core.db import get_session
from great_minds.core.storage import LocalStorage
from great_minds.core.users.models import User

log = logging.getLogger(__name__)

router = APIRouter(prefix="/brains", tags=["brains"])


@router.get("", response_model=list[schemas.BrainOverview])
async def list_brains(
    user: User = Depends(get_current_user),
    brain_service: BrainService = Depends(get_brain_service),
) -> list[schemas.BrainOverview]:
    rows = await brain_service.list_brains(user.id)
    return [
        schemas.BrainOverview(id=brain.id, name=brain.name, kind=brain.kind, role=role)
        for brain, role in rows
    ]


@router.post("", response_model=schemas.Brain, status_code=status.HTTP_201_CREATED)
async def create_brain(
    req: schemas.BrainCreate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
    brain_service: BrainService = Depends(get_brain_service),
) -> schemas.Brain:
    brain, role = await brain_service.create_team_brain(req.name, user.id)
    await session.commit()

    return schemas.Brain(
        id=brain.id, name=brain.name, kind=brain.kind, role=role,
        slug=brain.slug, owner_id=brain.owner_id, created_at=brain.created_at,
    )


@router.get("/{brain_id}", response_model=schemas.BrainDetail)
async def get_brain(
    brain_id: UUID,
    user: User = Depends(get_current_user),
    brain_service: BrainService = Depends(get_brain_service),
    settings: Settings = Depends(get_settings),
) -> schemas.BrainDetail:
    try:
        brain, role = await brain_service.get_brain(brain_id, user.id)
    except ValueError:
        raise HTTPException(status_code=404, detail="Brain not found")

    member_count = await brain_service.get_member_count(brain.id)
    storage = LocalStorage(Path(settings.data_dir) / brain.storage_root)
    article_count = len(brain_ops.list_articles(storage))

    return schemas.BrainDetail(
        id=brain.id, name=brain.name, kind=brain.kind, role=role,
        slug=brain.slug, owner_id=brain.owner_id, created_at=brain.created_at,
        member_count=member_count, article_count=article_count,
    )


@router.get("/{brain_id}/members", response_model=list[schemas.MembershipOverview])
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


@router.put("/{brain_id}/members/{member_user_id}", response_model=schemas.MembershipOverview)
async def set_member(
    brain_id: UUID,
    member_user_id: UUID,
    req: schemas.MembershipUpdate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
    brain_service: BrainService = Depends(get_brain_service),
) -> schemas.MembershipOverview:
    try:
        _brain, role = await brain_service.get_brain(brain_id, user.id)
    except ValueError:
        raise HTTPException(status_code=404, detail="Brain not found")
    if role != MemberRole.OWNER:
        raise HTTPException(status_code=403, detail="Only owners can manage members")

    try:
        new_role = MemberRole(req.role)
    except ValueError:
        raise HTTPException(status_code=422, detail=f"Invalid role: {req.role}")

    target_user = await session.get(User, member_user_id)
    if target_user is None:
        raise HTTPException(status_code=404, detail="User not found")

    await brain_service.upsert_membership(brain_id, member_user_id, new_role)
    await session.commit()

    return schemas.MembershipOverview(user_id=target_user.id, email=target_user.email, role=new_role)


@router.delete("/{brain_id}/members/{member_user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_member(
    brain_id: UUID,
    member_user_id: UUID,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
    brain_service: BrainService = Depends(get_brain_service),
) -> None:
    try:
        _brain, role = await brain_service.get_brain(brain_id, user.id)
    except ValueError:
        raise HTTPException(status_code=404, detail="Brain not found")
    if role != MemberRole.OWNER:
        raise HTTPException(status_code=403, detail="Only owners can manage members")

    deleted = await brain_service.delete_membership(brain_id, member_user_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Membership not found")
    await session.commit()
