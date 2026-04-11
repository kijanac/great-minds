"""Query request/response schemas."""

from pydantic import BaseModel

from great_minds.core.querier import QueryMode


class QueryRequest(BaseModel):
    question: str
    model: str | None = None
    origin_path: str | None = None
    session_context: str | None = None
    mode: QueryMode = QueryMode.QUERY
    extra_instructions: str | None = None


class QueryResponse(BaseModel):
    answer: str
