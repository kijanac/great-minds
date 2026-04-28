"""Task domain schemas."""

import enum
from datetime import datetime
from uuid import UUID

from pydantic import BaseModel


class TaskStatus(enum.StrEnum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class Task(BaseModel):
    id: UUID
    type: str
    created_at: datetime
    params: dict


class TaskDetail(Task):
    status: TaskStatus
    error: str | None
