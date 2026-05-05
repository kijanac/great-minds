"""Auth domain schemas."""

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class TokenPair(BaseModel):
    """OAuth2-style token response. Routes return this directly — no
    separate API schema needed since it has no internal-only fields."""

    access_token: str
    refresh_token: str
    token_type: str = Field(default="bearer")


class ApiKey(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    label: str
    created_at: datetime
    revoked: bool


class ApiKeyWithSecret(ApiKey):
    """Domain schema for a freshly created API key — includes the one-time raw secret."""

    raw_key: str
