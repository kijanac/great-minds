"""Session request/response schemas."""

from typing import Literal

from pydantic import BaseModel, ConfigDict

from great_minds.core.sessions import (
    BtwExchange,
    SessionEvent,
    SessionOrigin,
    ThinkingBlock,
)


class ExchangeData(BaseModel):
    id: str
    query: str
    thinking: list[ThinkingBlock] = []
    answer: str
    btws: list[dict] = []


class BtwData(BaseModel):
    anchor: str
    paragraph: str
    exchangeId: str
    paragraphIndex: int = -1
    exchanges: list[BtwExchange]


class CreateSessionRequest(BaseModel):
    session_id: str
    exchange: ExchangeData
    origin: SessionOrigin | None = None


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
    origin: SessionOrigin | None = None


class PromoteExchangeResponse(BaseModel):
    """Result of promoting a session exchange to a raw/sessions/ source.

    ``mode`` discriminates owner-direct ingest from member-proposal:
    - ``ingested``: ``document_id`` populated, source is in the corpus.
    - ``proposed``: ``proposal_id`` populated, awaiting owner review.
    """

    mode: Literal["ingested", "proposed"]
    path: str
    title: str
    document_id: str | None = None
    proposal_id: str | None = None
