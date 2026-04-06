"""Proposal domain schemas."""

import uuid
from datetime import datetime

from pydantic import BaseModel


class ProposalOverview(BaseModel):
    id: uuid.UUID
    brain_id: uuid.UUID
    status: str
    title: str | None
    content_type: str
    created_at: datetime


class Proposal(ProposalOverview):
    user_id: uuid.UUID
    author: str | None
    reviewed_by: uuid.UUID | None
    reviewed_at: datetime | None
