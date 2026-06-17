"""Session domain schemas and persisted event models."""

from datetime import datetime
from enum import StrEnum
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict


class ChunkRange(BaseModel):
    start: int
    end: int


class ThinkingSource(BaseModel):
    label: str
    type: Literal["article", "raw", "search", "query", "links"]
    thinking: str | None = None
    # Context-panel provenance for content cards (article/raw): which chunk
    # ranges the agent expanded with expand_context, and whether it read the
    # whole document. Empty/False for search/query/links cards, and for
    # sessions persisted before this field existed (they fall back to the
    # full document on click).
    ranges: list[ChunkRange] = []
    full: bool = False


class ThinkingBlock(BaseModel):
    sources: list[ThinkingSource] = []


class BtwExchange(BaseModel):
    """One Q/A round inside a BTW thread.

    Mirrors ExchangeEvent but without exId/ts — those live on the parent
    BtwEvent, since a BTW is a sequence of turns sharing one anchor and
    one position in the parent session.
    """

    query: str
    thinking: list[ThinkingBlock] = []
    answer: str = ""


class SessionOrigin(BaseModel):
    """Where this session was anchored when it was created.

    For sessions started by opening a doc, only ``doc_path`` is set.
    For sessions spun off from a document BTW, the passage triple
    (anchor + paragraph + paragraph_index) is also recorded so the
    UI can scroll back to the source highlight.
    """

    doc_path: str
    anchor: str | None = None
    paragraph: str | None = None
    paragraph_index: int | None = None


class EventType(StrEnum):
    META = "meta"
    EXCHANGE = "exchange"
    BTW = "btw"


class MetaEvent(BaseModel):
    type: EventType = EventType.META
    id: str
    query: str
    ts: str
    user_id: str
    origin: SessionOrigin | None = None


class ExchangeEvent(BaseModel):
    type: EventType = EventType.EXCHANGE
    exId: str
    query: str
    thinking: list[ThinkingBlock] = []
    answer: str = ""
    ts: str


class BtwEvent(BaseModel):
    type: EventType = EventType.BTW
    exId: str
    anchor: str
    paragraph: str
    pi: int = -1
    exchanges: list[BtwExchange]
    ts: str


type SessionEvent = MetaEvent | ExchangeEvent | BtwEvent


class ExchangeInput(BaseModel):
    id: str
    query: str
    thinking: list[ThinkingBlock] = []
    answer: str = ""


class BtwInput(BaseModel):
    exchangeId: str = ""
    anchor: str
    paragraph: str
    paragraphIndex: int = -1
    exchanges: list[BtwExchange]


class SessionOverview(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    query: str
    created_at: datetime
    updated_at: datetime
    user_id: UUID
    origin: SessionOrigin | None = None
