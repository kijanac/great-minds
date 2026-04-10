"""Lint request/response schemas."""

from pydantic import BaseModel, ConfigDict


class LintFixItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    file: str
    description: str


class LintCountsResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    dead_links: int
    broken_citations: int
    orphans: int
    uncompiled: int
    uncited: int
    missing_index: int
    tag_issues: int


class ResearchSuggestionItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    topic: str
    source: str
    mentioned_in: list[str]
    usage_count: int = 0
    suggested_category: str = ""


class ContradictionItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    description: str
    articles: list[str]


class LintResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    fixes_applied: list[LintFixItem]
    remaining_issues: int
    counts: LintCountsResponse
    research_suggestions: list[ResearchSuggestionItem] = []
    contradictions: list[ContradictionItem] = []
