"""Public job API schemas."""

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, computed_field

from great_minds.core.pipeline_runs import (
    PipelineProgressStep,
    PipelineRunStatus,
    PipelineTrigger,
)


class JobResponse(BaseModel):
    """Public representation of a user-visible processing job.

    Internally jobs are backed by pipeline run records, but the API exposes
    them as jobs. Absurd task IDs and compile intents are implementation
    details and intentionally omitted.
    """

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    vault_id: UUID
    trigger: PipelineTrigger
    status: PipelineRunStatus

    current_phase: str = ""
    phase_status: str = ""
    progress_steps: list[PipelineProgressStep]
    error: str | None = None

    created_at: datetime
    updated_at: datetime
    completed_at: datetime | None = None

    @computed_field
    @property
    def stream_url(self) -> str:
        return f"/jobs/{self.id}/stream"
