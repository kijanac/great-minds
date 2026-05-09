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


class PipelineTaskType(StrEnum):
    STAGED_FILE_INGEST = "staged_file_ingest"
    COMPILE = "compile"


class PipelinePhaseStatus(StrEnum):
    STARTED = "started"
    PROGRESS = "progress"
    COMPLETED = "completed"
    FAILED = "failed"


class PipelineStepStatus(StrEnum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"


class PipelineProgressStep(BaseModel):
    key: str
    label: str
    status: PipelineStepStatus
    done: int | None = None
    total: int | None = None
    detail: str = ""


class PipelineRun(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    vault_id: UUID
    trigger: PipelineTrigger
    status: PipelineRunStatus

    current_phase: str = ""
    phase_status: str = ""
    progress_steps: list[PipelineProgressStep]
    error: str | None = None

    ingest_task_id: UUID | None = None
    compile_intent_id: UUID | None = None
    compile_task_id: UUID | None = None
    active_task_id: UUID | None = None
    active_task_type: PipelineTaskType | None = None

    created_at: datetime
    updated_at: datetime
    completed_at: datetime | None = None


class PipelineRunCreate(BaseModel):
    id: UUID
    vault_id: UUID
    trigger: PipelineTrigger
    status: PipelineRunStatus = PipelineRunStatus.PENDING


class PipelineRunUpdate(BaseModel):
    phase: PipelinePhase
    status: PipelinePhaseStatus
    progress_steps: list[PipelineProgressStep]
    error: str | None = None
