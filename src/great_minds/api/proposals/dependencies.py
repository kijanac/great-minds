"""Proposal FastAPI dependencies."""

from fastapi import Depends

from great_minds.api.brains.dependencies import get_brain_service
from great_minds.api.brains.service import BrainService
from great_minds.api.proposals.service import ProposalService


def get_proposal_service(
    brain_service: BrainService = Depends(get_brain_service),
) -> ProposalService:
    return ProposalService(brain_service)
