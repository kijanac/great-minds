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
    reviewed_by: uuid.UUID | None
    reviewed_at: datetime | None
