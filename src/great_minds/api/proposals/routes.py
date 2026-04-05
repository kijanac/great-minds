"""Source proposal routes."""

import logging
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.api.auth.dependencies import get_current_user
from great_minds.api.auth.models import User
from great_minds.api.brains.models import Brain, BrainType, MemberRole
from great_minds.api.brains.repository import get_brain_with_role
from great_minds.api.brains.service import get_brain_instance, get_task_manager
from great_minds.api.db import get_session
from great_minds.api.proposals import repository, schemas
from great_minds.api.proposals.models import ProposalStatus, SourceProposal
from great_minds.api.settings import Settings, get_settings

log = logging.getLogger(__name__)

router = APIRouter(prefix="/proposals", tags=["proposals"])


@router.post("", response_model=schemas.Proposal, status_code=status.HTTP_201_CREATED)
async def create_proposal(
    req: schemas.ProposalCreate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> schemas.Proposal:
    result = await get_brain_with_role(session, req.brain_id, user.id)
    if result is None:
        raise HTTPException(status_code=404, detail="Brain not found")

    brain_row, _role = result
    if brain_row.type != BrainType.TEAM:
        raise HTTPException(status_code=400, detail="Proposals are only for team brains")

    proposal = await repository.create_proposal(
        session,
        brain_id=req.brain_id,
        user_id=user.id,
        content_type=req.content_type,
        title=req.title,
        author=req.author,
        storage_path="",
    )

    storage_path = f"{settings.proposals_storage_root}/{proposal.id}.md"
    proposal.storage_path = storage_path

    # Write file before commit — if this fails, DB transaction rolls back
    path = Path(storage_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        path.write_text(req.content, encoding="utf-8")
    except OSError:
        await session.rollback()
        raise HTTPException(status_code=500, detail="Failed to store proposal content")

    await session.commit()
    await session.refresh(proposal)
    return _to_schema(proposal)


@router.get("", response_model=list[schemas.ProposalOverview])
async def list_proposals(
    brain: str | None = Query(None),
    status_filter: ProposalStatus | None = Query(None, alias="status"),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> list[schemas.ProposalOverview]:
    proposals = await repository.list_proposals(session, user.id, brain_id=brain, status=status_filter)
    return [
        schemas.ProposalOverview(
            id=p.id, brain_id=p.brain_id, status=p.status,
            title=p.title, content_type=p.content_type, created_at=p.created_at,
        )
        for p in proposals
    ]


@router.get("/{proposal_id}", response_model=schemas.Proposal)
async def get_proposal(
    proposal_id: UUID,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> schemas.Proposal:
    proposal = await repository.get_authorized_proposal(session, proposal_id, user.id)
    if proposal is None:
        raise HTTPException(status_code=404, detail="Proposal not found")
    return _to_schema(proposal)


@router.patch("/{proposal_id}", response_model=schemas.Proposal)
async def review_proposal(
    proposal_id: UUID,
    req: schemas.ProposalReview,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> schemas.Proposal:
    try:
        new_status = ProposalStatus(req.status)
    except ValueError:
        raise HTTPException(status_code=422, detail=f"Invalid status: {req.status}. Must be 'approved' or 'rejected'.")
    if new_status == ProposalStatus.PENDING:
        raise HTTPException(status_code=400, detail="Cannot set status back to pending")

    proposal = await repository.get_authorized_proposal(session, proposal_id, user.id)
    if proposal is None:
        raise HTTPException(status_code=404, detail="Proposal not found")
    if proposal.status != ProposalStatus.PENDING:
        raise HTTPException(status_code=409, detail="Proposal already reviewed")

    result = await get_brain_with_role(session, proposal.brain_id, user.id)
    if result is None or result[1] != MemberRole.OWNER:
        raise HTTPException(status_code=403, detail="Only brain owners can review proposals")
    brain_row = result[0]

    proposal.status = new_status
    proposal.reviewed_by = user.id
    proposal.reviewed_at = datetime.now(UTC)

    if new_status == ProposalStatus.APPROVED:
        content = Path(proposal.storage_path).read_text(encoding="utf-8")
        brain_instance = get_brain_instance(brain_row)

        kwargs = {}
        if proposal.title:
            kwargs["title"] = proposal.title
        if proposal.author:
            kwargs["author"] = proposal.author
        brain_instance.ingest_document(content, proposal.content_type, **kwargs)

        manager = get_task_manager(brain_row)
        await manager.compile()

    if new_status == ProposalStatus.REJECTED:
        path = Path(proposal.storage_path)
        if path.exists():
            path.unlink()

    await session.commit()
    await session.refresh(proposal)
    return _to_schema(proposal)


def _to_schema(p: SourceProposal) -> schemas.Proposal:
    return schemas.Proposal(
        id=p.id, brain_id=p.brain_id, status=p.status, title=p.title,
        content_type=p.content_type, created_at=p.created_at, user_id=p.user_id,
        author=p.author, reviewed_by=p.reviewed_by, reviewed_at=p.reviewed_at,
    )
