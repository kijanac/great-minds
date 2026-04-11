"""Session request/response schemas."""

from pydantic import BaseModel, ConfigDict

from great_minds.core.sessions import (
    BtwMessage,
    SessionEvent,
    ThinkingBlock,
)


class ExchangeData(BaseModel):
    query: str
    thinking: list[ThinkingBlock] = []
    answer: str
    btws: list[dict] = []


class BtwData(BaseModel):
    anchor: str
    paragraph: str
    exchangeId: str
    paragraphIndex: int = -1
    messages: list[BtwMessage]


class CreateSessionRequest(BaseModel):
    session_id: str
    exchange: ExchangeData
    origin: str | None = None


class SessionPathResponse(BaseModel):
    path: str


class SessionResponse(BaseModel):
    id: str
    events: list[SessionEvent]


class SessionListItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    query: str
    created: str
    updated: str
    origin: str | None = None
