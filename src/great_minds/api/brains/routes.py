"""Brain CRUD and membership routes."""

import logging
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.api.auth.dependencies import get_current_user
from great_minds.api.auth.models import User
from great_minds.api.brains import repository, schemas
from great_minds.api.brains.models import Brain, BrainType, MemberRole
from great_minds.api.brains.service import get_brain_instance
from great_minds.api.db import get_session

log = logging.getLogger(__name__)

router = APIRouter(prefix="/brains", tags=["brains"])


@router.get("", response_model=list[schemas.BrainOverview])
async def list_brains(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> list[schemas.BrainOverview]:
    rows = await repository.list_user_brains(session, user.id)
    return [
        schemas.BrainOverview(id=brain.id, name=brain.name, type=brain.type, role=role)
        for brain, role in rows
    ]


@router.post("", response_model=schemas.Brain, status_code=status.HTTP_201_CREATED)
async def create_brain(
    req: schemas.BrainCreate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> schemas.Brain:
    slug = req.name.lower().replace(" ", "-")
    brain = Brain(
        name=req.name,
        slug=slug,
        owner_id=user.id,
        type=BrainType.TEAM,
        storage_root=f"brains/{slug}",
    )
    session.add(brain)
    await session.flush()
    await repository.upsert_membership(session, brain.id, user.id, MemberRole.OWNER)
    await session.commit()
    await session.refresh(brain)

    return schemas.Brain(
        id=brain.id, name=brain.name, type=brain.type, role=MemberRole.OWNER,
        slug=brain.slug, owner_id=brain.owner_id, created_at=brain.created_at,
    )


@router.get("/{brain_id}", response_model=schemas.BrainDetail)
async def get_brain(
    brain_id: UUID,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> schemas.BrainDetail:
    result = await repository.get_brain_with_role(session, brain_id, user.id)
    if result is None:
        raise HTTPException(status_code=404, detail="Brain not found")
    brain, role = result

    member_count = await repository.get_member_count(session, brain.id)
    storage = get_brain_instance(brain).storage
    article_count = len(storage.glob("wiki/*.md"))

    return schemas.BrainDetail(
        id=brain.id, name=brain.name, type=brain.type, role=role,
        slug=brain.slug, owner_id=brain.owner_id, created_at=brain.created_at,
        member_count=member_count, article_count=article_count,
    )


@router.get("/{brain_id}/members", response_model=list[schemas.MembershipOverview])
async def list_members(
    brain_id: UUID,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> list[schemas.MembershipOverview]:
    result = await repository.get_brain_with_role(session, brain_id, user.id)
    if result is None:
        raise HTTPException(status_code=404, detail="Brain not found")

    rows = await repository.list_members(session, brain_id)
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
) -> schemas.MembershipOverview:
    result = await repository.get_brain_with_role(session, brain_id, user.id)
    if result is None:
        raise HTTPException(status_code=404, detail="Brain not found")
    _, role = result
    if role != MemberRole.OWNER:
        raise HTTPException(status_code=403, detail="Only owners can manage members")

    try:
        new_role = MemberRole(req.role)
    except ValueError:
        raise HTTPException(status_code=422, detail=f"Invalid role: {req.role}")

    target_user = await session.get(User, member_user_id)
    if target_user is None:
        raise HTTPException(status_code=404, detail="User not found")

    await repository.upsert_membership(session, brain_id, member_user_id, new_role)
    await session.commit()

    return schemas.MembershipOverview(user_id=target_user.id, email=target_user.email, role=new_role)


@router.delete("/{brain_id}/members/{member_user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_member(
    brain_id: UUID,
    member_user_id: UUID,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> None:
    result = await repository.get_brain_with_role(session, brain_id, user.id)
    if result is None:
        raise HTTPException(status_code=404, detail="Brain not found")
    _, role = result
    if role != MemberRole.OWNER:
        raise HTTPException(status_code=403, detail="Only owners can manage members")

    deleted = await repository.delete_membership(session, brain_id, member_user_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Membership not found")
    await session.commit()
