"""Proposal routes — nested under /vaults/{vault_id}/proposals.

List, get, and review only. Proposals are created by other domains
(sessions, feedback, ingest) when a non-owner member contributes content
that requires vault-owner approval.
"""

import logging
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, HTTPException, Query, status

from great_minds.app.api.dependencies import (
    VaultOwnerGuard,
    VaultServiceDep,
    PageParamsQuery,
    ProposalServiceDep,
)
from great_minds.core.pagination import Page
from great_minds.core.proposals import ProposalStatus
from great_minds.core.proposals.schemas import Proposal, ProposalOverview, ProposalUpdate

log = logging.getLogger(__name__)

router = APIRouter(prefix="/proposals", tags=["proposals"])


@router.get("")
async def list_proposals(
    vault_id: UUID,
    pagination: PageParamsQuery,
    proposal_service: ProposalServiceDep,
    status_filter: Annotated[ProposalStatus | None, Query(alias="status")] = None,
) -> Page[ProposalOverview]:
    return await proposal_service.list_for_vault(
        vault_id, status=status_filter, pagination=pagination
    )


@router.get("/{proposal_id}")
async def get_proposal(
    proposal_id: UUID,
    proposal_service: ProposalServiceDep,
) -> Proposal:
    proposal = await proposal_service.get(proposal_id)
    if proposal is None:
        raise HTTPException(status_code=404, detail="Proposal not found")
    return proposal


@router.patch("/{proposal_id}")
async def review_proposal(
    proposal_id: UUID,
    req: ProposalUpdate,
    vault_id: UUID,
    _auth: VaultOwnerGuard,
    vault_service: VaultServiceDep,
    proposal_service: ProposalServiceDep,
) -> Proposal:
    if req.status == ProposalStatus.PENDING:
        raise HTTPException(status_code=400, detail="Cannot set status back to pending")

    storage = await vault_service.get_storage_by_id(vault_id)

    try:
        return await proposal_service.review(
            proposal_id=proposal_id,
            new_status=req.status,
            storage=storage,
        )
    except ValueError as e:
        msg = str(e)
        if msg == "Proposal not found":
            raise HTTPException(status_code=404, detail=msg)
        raise HTTPException(status_code=409, detail=msg)
