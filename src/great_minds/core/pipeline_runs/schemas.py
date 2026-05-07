"""PipelineRun domain schemas."""

from datetime import datetime
from enum import StrEnum
from uuid import UUID

from pydantic import BaseModel, ConfigDict


class PipelineRunStatus(StrEnum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class PipelineTrigger(StrEnum):
    STAGED_FILES = "staged_files"
    URL = "url"
    MANUAL = "manual"


class PipelinePhase(StrEnum):
    UPLOAD = "upload"
    SOURCE_INGEST = "source_ingest"
    INGEST = "ingest"
    EXTRACT = "extract"
    ABSTRACT = "abstract"
    DERIVE = "derive"
    RENDER = "render"
    VERIFY = "verify"
    PUBLISH = "publish"


class PipelinePhaseStatus(StrEnum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"


class PipelineRun(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    vault_id: UUID
    trigger: PipelineTrigger
    status: PipelineRunStatus

    current_phase: str = ""
    phase_status: str = ""
    progress_done: int = 0
    progress_total: int = 0
    progress_failed: int = 0
    progress_message: str = ""
    error: str | None = None

    ingest_task_id: UUID | None = None
    compile_intent_id: UUID | None = None
    compile_task_id: UUID | None = None

    created_at: datetime
    updated_at: datetime
    completed_at: datetime | None = None


class PipelineRunCreate(BaseModel):
    id: UUID
    vault_id: UUID
    trigger: PipelineTrigger
    status: PipelineRunStatus = PipelineRunStatus.PENDING
