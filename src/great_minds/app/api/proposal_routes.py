"""Source proposal routes — nested under /brains/{brain_id}/proposals."""

import logging
from uuid import UUID

from absurd_sdk import AsyncAbsurd
from fastapi import APIRouter, Depends, HTTPException, Query, status

from great_minds.app.api.dependencies import (
    get_absurd,
    get_brain_service,
    get_current_user,
    get_proposal_service,
    require_brain_member,
    require_brain_owner,
)
from great_minds.app.api.schemas import proposals as schemas
from great_minds.core.brains.service import BrainService
from great_minds.core.proposals.models import ProposalStatus
from great_minds.core.proposals.service import ProposalService
from great_minds.core.users.models import User

log = logging.getLogger(__name__)

router = APIRouter(prefix="/proposals", tags=["proposals"])


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_proposal(
    req: schemas.ProposalCreate,
    brain_id: UUID,
    user: User = Depends(get_current_user),
    proposal_service: ProposalService = Depends(get_proposal_service),
    _auth: None = Depends(require_brain_member),
) -> schemas.Proposal:
    proposal = await proposal_service.create(
        brain_id=brain_id,
        user_id=user.id,
        content=req.content,
        content_type=req.content_type,
        title=req.title,
        author=req.author,
    )
    return schemas.Proposal.model_validate(proposal)


@router.get("")
async def list_proposals(
    brain_id: UUID,
    status_filter: ProposalStatus | None = Query(None, alias="status"),
    proposal_service: ProposalService = Depends(get_proposal_service),
    _auth: None = Depends(require_brain_member),
) -> list[schemas.ProposalOverview]:
    proposals = await proposal_service.list_for_brain(brain_id, status=status_filter)
    return [schemas.ProposalOverview.model_validate(p) for p in proposals]


@router.get("/{proposal_id}")
async def get_proposal(
    proposal_id: UUID,
    brain_id: UUID,
    proposal_service: ProposalService = Depends(get_proposal_service),
    _auth: None = Depends(require_brain_member),
) -> schemas.Proposal:
    proposal = await proposal_service.get(proposal_id, brain_id)
    if proposal is None:
        raise HTTPException(status_code=404, detail="Proposal not found")
    return schemas.Proposal.model_validate(proposal)


@router.patch("/{proposal_id}")
async def review_proposal(
    proposal_id: UUID,
    req: schemas.ProposalReview,
    brain_id: UUID,
    user: User = Depends(get_current_user),
    absurd: AsyncAbsurd = Depends(get_absurd),
    brain_service: BrainService = Depends(get_brain_service),
    proposal_service: ProposalService = Depends(get_proposal_service),
    _auth: None = Depends(require_brain_owner),
) -> schemas.Proposal:
    if req.status == ProposalStatus.PENDING:
        raise HTTPException(status_code=400, detail="Cannot set status back to pending")

    proposal = await proposal_service.get(proposal_id, brain_id)
    if proposal is None:
        raise HTTPException(status_code=404, detail="Proposal not found")
    if proposal.status != ProposalStatus.PENDING:
        raise HTTPException(status_code=409, detail="Proposal already reviewed")

    brain = await brain_service.get_by_id(brain_id)
    storage = brain_service.get_storage(brain)
    proposal = await proposal_service.review(
        proposal, user.id, req.status, brain, storage, absurd
    )
    return schemas.Proposal.model_validate(proposal)
