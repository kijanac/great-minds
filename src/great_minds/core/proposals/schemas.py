"""Proposal domain schemas."""

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict

from great_minds.core.proposals.models import ProposalStatus


class ProposalOverview(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    vault_id: uuid.UUID
    status: ProposalStatus
    title: str | None
    content_type: str
    created_at: datetime


class Proposal(ProposalOverview):
    user_id: uuid.UUID
    author: str | None
    dest_path: str
    document_id: uuid.UUID | None = None


class ProposalCreate(BaseModel):
    """Input for ProposalService.create().

    Routes resolve vault_id/user_id from path/auth, pre-render the
    markdown, compute dest_path, and pass the bundled result here.
    """

    content_type: str
    title: str
    author: str | None
    dest_path: str
    rendered: str


class ProposalUpdate(BaseModel):
    status: ProposalStatus
