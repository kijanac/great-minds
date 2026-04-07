"""Source proposal routes."""

import logging
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID

from absurd_sdk import AsyncAbsurd
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.app.api.dependencies import get_absurd, get_brain_service, get_current_user, get_proposal_service
from great_minds.app.api.schemas import proposals as schemas
from great_minds.core.brains.models import MemberRole
from great_minds.core.brains.service import BrainService
from great_minds.core.db import get_session
from great_minds.core.proposals import repository
from great_minds.core.proposals.models import ProposalStatus, SourceProposal
from great_minds.core.proposals.service import ProposalService
from great_minds.core.settings import Settings, get_settings
from great_minds.core.users.models import User

log = logging.getLogger(__name__)

router = APIRouter(prefix="/proposals", tags=["proposals"])


@router.post("", response_model=schemas.Proposal, status_code=status.HTTP_201_CREATED)
async def create_proposal(
    req: schemas.ProposalCreate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
    brain_service: BrainService = Depends(get_brain_service),
) -> schemas.Proposal:
    try:
        brain, _role = await brain_service.get_brain(req.brain_id, user.id)
    except ValueError:
        raise HTTPException(status_code=404, detail="Brain not found")

    if brain.kind != "team":
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

    storage_path = f"{settings.data_dir}/proposals/{proposal.id}.md"
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
    absurd: AsyncAbsurd = Depends(get_absurd),
    brain_service: BrainService = Depends(get_brain_service),
    proposal_service: ProposalService = Depends(get_proposal_service),
) -> schemas.Proposal:
    if req.status == ProposalStatus.PENDING:
        raise HTTPException(status_code=400, detail="Cannot set status back to pending")

    proposal = await repository.get_authorized_proposal(session, proposal_id, user.id)
    if proposal is None:
        raise HTTPException(status_code=404, detail="Proposal not found")
    if proposal.status != ProposalStatus.PENDING:
        raise HTTPException(status_code=409, detail="Proposal already reviewed")

    try:
        brain, role = await brain_service.get_brain(proposal.brain_id, user.id)
    except ValueError:
        raise HTTPException(status_code=403, detail="Only brain owners can review proposals")
    if role != MemberRole.OWNER:
        raise HTTPException(status_code=403, detail="Only brain owners can review proposals")

    proposal.status = req.status
    proposal.reviewed_by = user.id
    proposal.reviewed_at = datetime.now(UTC)

    if req.status == ProposalStatus.APPROVED:
        await proposal_service.approve(proposal, brain, absurd, session)

    if req.status == ProposalStatus.REJECTED:
        proposal_service.reject(proposal)

    await session.commit()
    await session.refresh(proposal)
    return _to_schema(proposal)


def _to_schema(p: SourceProposal) -> schemas.Proposal:
    return schemas.Proposal(
        id=p.id, brain_id=p.brain_id, status=p.status, title=p.title,
        content_type=p.content_type, created_at=p.created_at, user_id=p.user_id,
        author=p.author, reviewed_by=p.reviewed_by, reviewed_at=p.reviewed_at,
    )
