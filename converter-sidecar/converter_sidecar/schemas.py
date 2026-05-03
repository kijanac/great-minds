"""Public API schemas for the converter sidecar."""

from enum import StrEnum
from uuid import UUID, uuid4

from pydantic import BaseModel, Field


class ConverterTarget(StrEnum):
    """What kind of source the converter should handle."""

    URL = "url"
    FILE = "file"
    CORPUS = "corpus"  # multi-page crawl


class ConvertRequest(BaseModel):
    """Request to convert content to markdown.

    ``goal`` is the key differentiator from a dumb converter. The agent
    uses it to decide strategy: a goal of "collect all of Lenin's 1897
    articles from marxists.org" triggers crawl + structure extraction,
    while "convert this PDF to markdown" triggers a simple file conversion.
    """

    source: str = Field(description="URL, file path, or corpus entry point")
    target: ConverterTarget = ConverterTarget.URL
    goal: str = Field(
        default="",
        description="What the user wants to extract. Empty = best-effort conversion.",
    )
    recipe_id: str | None = Field(
        default=None,
        description="Pre-approved recipe to use (skips agent planning).",
    )
    max_tool_calls: int = Field(default=12, ge=1, le=30)


class ConvertResponse(BaseModel):
    """Result of a conversion.

    If ``status`` is 'complete', ``files`` contains the output.
    If ``status`` is 'partial', the agent hit its tool-call budget.
    ``recipe_id`` is set when a new recipe was learned (for human review).
    """

    id: UUID = Field(default_factory=uuid4)
    status: str = "complete"  # complete, partial, failed
    files: list["ConvertedFile"] = Field(default_factory=list)
    recipe_id: str | None = None
    trace: list["ToolCallTrace"] = Field(
        default_factory=list,
        description="What the agent did, for debugging.",
    )


class ConvertedFile(BaseModel):
    path: str = Field(description="Relative path, e.g. 'lenin/1897/article-1.md'")
    content: str
    content_type: str = "texts"
    metadata: dict = Field(default_factory=dict)


class ToolCallTrace(BaseModel):
    tool: str
    args: dict = Field(default_factory=dict)
    ok: bool
    summary: str = ""  # e.g. "extracted 47 links", "converted 12KB HTML→3KB md"


class RecipeInfo(BaseModel):
    """Metadata about a known recipe."""

    id: str
    domain: str
    description: str
    approved: bool
    use_count: int


class ToolInfo(BaseModel):
    """Metadata about an available tool."""

    name: str
    description: str
    parameters: dict  # JSON Schema
