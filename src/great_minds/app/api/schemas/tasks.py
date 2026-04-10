"""Task API schemas — request models only."""

from pydantic import BaseModel


class CompileRequest(BaseModel):
    limit: int | None = None
