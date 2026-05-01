"""Source proposal routes — nested under /brains/{brain_id}/proposals."""

import logging
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, HTTPException, Query, status

from great_minds.app.api.dependencies import (
    BrainOwnerGuard,
    BrainServiceDep,
    BrainStorageDep,
    CurrentUser,
    PageParamsQuery,
    ProposalServiceDep,
)
from great_minds.app.api.schemas import proposals as schemas
from great_minds.core.pagination import Page
from great_minds.core.proposals import ProposalStatus

log = logging.getLogger(__name__)

router = APIRouter(prefix="/proposals", tags=["proposals"])


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_proposal(
    req: schemas.ProposalCreate,
    brain_id: UUID,
    user: CurrentUser,
    storage: BrainStorageDep,
    proposal_service: ProposalServiceDep,
) -> schemas.Proposal:
    proposal = await proposal_service.create(
        brain_id=brain_id,
        user_id=user.id,
        storage=storage,
        content=req.content,
        content_type=req.content_type,
        title=req.title,
        author=req.author,
    )
    return schemas.Proposal.model_validate(proposal)


@router.get("")
async def list_proposals(
    brain_id: UUID,
    pagination: PageParamsQuery,
    proposal_service: ProposalServiceDep,
    status_filter: Annotated[ProposalStatus | None, Query(alias="status")] = None,
) -> Page[schemas.ProposalOverview]:
    result = await proposal_service.list_for_brain_page(
        brain_id, status=status_filter, pagination=pagination
    )
    return Page(
        items=[schemas.ProposalOverview.model_validate(p) for p in result.items],
        pagination=result.pagination,
    )


@router.get("/{proposal_id}")
async def get_proposal(
    proposal_id: UUID,
    brain_id: UUID,
    proposal_service: ProposalServiceDep,
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
    user: CurrentUser,
    _auth: BrainOwnerGuard,
    brain_service: BrainServiceDep,
    proposal_service: ProposalServiceDep,
) -> schemas.Proposal:
    if req.status == ProposalStatus.PENDING:
        raise HTTPException(status_code=400, detail="Cannot set status back to pending")

    proposal = await proposal_service.get(proposal_id, brain_id)
    if proposal is None:
        raise HTTPException(status_code=404, detail="Proposal not found")
    if proposal.status != ProposalStatus.PENDING:
        raise HTTPException(status_code=409, detail="Proposal already reviewed")

    brain = await brain_service.get_brain(brain_id)
    storage = brain_service.get_storage(brain)
    proposal = await proposal_service.review(
        proposal, user.id, req.status, brain, storage
    )
    return schemas.Proposal.model_validate(proposal)
