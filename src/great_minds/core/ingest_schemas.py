"""Core ingest schemas shared by API and ingest services."""

from pydantic import BaseModel


class StagedFileInput(BaseModel):
    """One client-declared staged file manifest entry."""

    name: str
    size: int
    hash: str
    mimetype: str = ""


class StagedFileSignedUpload(BaseModel):
    hash: str
    url: str


class LocalFileInput(StagedFileInput):
    """One direct local ingest file manifest entry."""

    path: str | None = None
