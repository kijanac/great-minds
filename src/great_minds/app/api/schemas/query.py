"""Query request schemas."""

from pydantic import BaseModel

from great_minds.core.querier import HistoryMessage, QueryMode


class QueryRequest(BaseModel):
    question: str
    model: str | None = None
    origin_path: str | None = None
    history: list[HistoryMessage] = []
    mode: QueryMode = QueryMode.QUERY
    extra_instructions: str | None = None
