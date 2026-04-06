import uuid

from pydantic import BaseModel

from great_minds.core.proposals.models import ProposalStatus
from great_minds.core.proposals.schemas import Proposal, ProposalOverview


class ProposalCreate(BaseModel):
    brain_id: uuid.UUID
    content: str
    content_type: str = "texts"
    title: str | None = None
    author: str | None = None


class ProposalReview(BaseModel):
    status: ProposalStatus
