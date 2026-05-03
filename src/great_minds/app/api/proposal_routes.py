"""Source proposal routes — nested under /vaults/{vault_id}/proposals."""

import logging
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, HTTPException, Query, status

from great_minds.app.api.dependencies import (
    VaultOwnerGuard,
    VaultServiceDep,
    VaultStorageDep,
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
    vault_id: UUID,
    user: CurrentUser,
    storage: VaultStorageDep,
    proposal_service: ProposalServiceDep,
) -> schemas.Proposal:
    proposal = await proposal_service.create(
        vault_id=vault_id,
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
    vault_id: UUID,
    pagination: PageParamsQuery,
    proposal_service: ProposalServiceDep,
    status_filter: Annotated[ProposalStatus | None, Query(alias="status")] = None,
) -> Page[schemas.ProposalOverview]:
    result = await proposal_service.list_for_vault_page(
        vault_id, status=status_filter, pagination=pagination
    )
    return Page(
        items=[schemas.ProposalOverview.model_validate(p) for p in result.items],
        pagination=result.pagination,
    )


@router.get("/{proposal_id}")
async def get_proposal(
    proposal_id: UUID,
    vault_id: UUID,
    proposal_service: ProposalServiceDep,
) -> schemas.Proposal:
    proposal = await proposal_service.get(proposal_id, vault_id)
    if proposal is None:
        raise HTTPException(status_code=404, detail="Proposal not found")
    return schemas.Proposal.model_validate(proposal)


@router.patch("/{proposal_id}")
async def review_proposal(
    proposal_id: UUID,
    req: schemas.ProposalReview,
    vault_id: UUID,
    user: CurrentUser,
    _auth: VaultOwnerGuard,
    vault_service: VaultServiceDep,
    proposal_service: ProposalServiceDep,
) -> schemas.Proposal:
    if req.status == ProposalStatus.PENDING:
        raise HTTPException(status_code=400, detail="Cannot set status back to pending")

    proposal = await proposal_service.get(proposal_id, vault_id)
    if proposal is None:
        raise HTTPException(status_code=404, detail="Proposal not found")
    if proposal.status != ProposalStatus.PENDING:
        raise HTTPException(status_code=409, detail="Proposal already reviewed")

    vault = await vault_service.get_vault(vault_id)
    storage = vault_service.get_storage(vault)
    proposal = await proposal_service.review(
        proposal, user.id, req.status, vault, storage
    )
    return schemas.Proposal.model_validate(proposal)
