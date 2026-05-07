"""Task API schemas — request models only."""

from uuid import UUID

from pydantic import BaseModel


class CompileRequest(BaseModel):
    """Client-created job for a manual compile."""

    job_id: UUID
