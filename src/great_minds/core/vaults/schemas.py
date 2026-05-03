"""Vault domain schemas."""

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict

from great_minds.core.vaults.models import MemberRole

class Vault(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    owner_id: uuid.UUID
    created_at: datetime
    r2_bucket_name: str | None = None


class VaultWithRole(BaseModel):
    vault: Vault
    role: MemberRole


class MemberWithEmail(BaseModel):
    user_id: uuid.UUID
    role: MemberRole
    email: str
