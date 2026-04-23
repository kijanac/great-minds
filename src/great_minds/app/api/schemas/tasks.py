"""Task API schemas — request models only."""

from pydantic import BaseModel


class CompileRequest(BaseModel):
    """Empty for now — compile has no per-run parameters.

    Kept as a distinct schema so future compile-level options (e.g.
    force re-render, scoped to a subset of topics) have a place to
    land without API shape changes.
    """
