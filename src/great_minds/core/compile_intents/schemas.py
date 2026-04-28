"""CompileIntent domain schemas."""

from datetime import datetime
from enum import StrEnum
from uuid import UUID

from pydantic import BaseModel, ConfigDict, computed_field


class IntentStatus(StrEnum):
    PENDING = "pending"
    DISPATCHED = "dispatched"
    SATISFIED = "satisfied"


class CompileIntent(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    brain_id: UUID
    created_at: datetime
    dispatched_at: datetime | None
    dispatched_task_id: UUID | None
    satisfied_at: datetime | None

    @computed_field
    @property
    def status(self) -> IntentStatus:
        if self.satisfied_at is not None:
            return IntentStatus.SATISFIED
        if self.dispatched_at is not None:
            return IntentStatus.DISPATCHED
        return IntentStatus.PENDING
