"""Task domain schemas."""

import enum
from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict


class TaskStatus(enum.StrEnum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class Task(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    type: str
    created_at: datetime
    params: dict


class TaskDetail(Task):
    status: TaskStatus
    error: str | None
