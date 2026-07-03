"""JSONL-backed session event repository."""

import json
import logging
from datetime import datetime, timezone
from uuid import UUID

from pydantic import ValidationError
from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.core.storage import Storage

from .models import SessionRecordORM

from .schemas import (
    BtwEvent,
    EventType,
    ExchangeEvent,
    MetaEvent,
    SessionEvent,
    SessionOverview,
)

log = logging.getLogger(__name__)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_iso(ts: str) -> datetime:
    return datetime.fromisoformat(ts)


def _parse_event(data: dict) -> SessionEvent | None:
    """Parse a raw JSON dict into a typed event model."""
    event_type = data.get("type")
    try:
        match event_type:
            case EventType.META:
                return MetaEvent.model_validate(data)
            case EventType.EXCHANGE:
                return ExchangeEvent.model_validate(data)
            case EventType.BTW:
                return BtwEvent.model_validate(data)
            case _:
                log.warning("unknown event type: %s", event_type)
                return None
    except ValidationError as e:
        log.warning("invalid %s event: %s", event_type, e)
        return None


class SessionRepository:
    """Persist and query session JSONL event logs in vault storage."""

    def __init__(self, storage: Storage, session: AsyncSession) -> None:
        self.storage = storage
        self.session = session

    async def mkdir(self) -> None:
        await self.storage.mkdir("sessions")

    async def append_event(self, session_id: str, event: SessionEvent) -> None:
        await self.storage.append(
            f"sessions/{session_id}.jsonl", json.dumps(event.model_dump()) + "\n"
        )

    async def write_markdown(self, session_id: str, markdown: str) -> None:
        await self.storage.write(f"sessions/{session_id}.md", markdown)

    async def read_markdown(self, session_id: str) -> str | None:
        return await self.storage.read(f"sessions/{session_id}.md")

    async def load_events(self, session_id: str) -> list[SessionEvent]:
        """Load all events from a session's JSONL file.

        Truncates at the first malformed line (partial write recovery).
        Invalid events are skipped with a warning.
        """
        content = await self.storage.read(f"sessions/{session_id}.jsonl")
        if content is None:
            return []
        events: list[SessionEvent] = []
        for line in content.strip().split("\n"):
            if not line.strip():
                continue
            try:
                data = json.loads(line)
            except json.JSONDecodeError:
                break
            event = _parse_event(data)
            if event is not None:
                events.append(event)
        return events

    async def find_by_idempotency_key(self, vault_id: UUID, key: str) -> str | None:
        """Return the session id previously created with this key, or None."""
        return await self.session.scalar(
            select(SessionRecordORM.id).where(
                SessionRecordORM.vault_id == vault_id,
                SessionRecordORM.idempotency_key == key,
            )
        )

    async def upsert_overview(
        self,
        vault_id: UUID,
        meta: MetaEvent,
        *,
        updated_at: str,
        idempotency_key: str | None = None,
    ) -> None:
        """Upsert the DB listing index for a session JSONL event log."""
        stmt = (
            insert(SessionRecordORM)
            .values(
                id=meta.id,
                vault_id=vault_id,
                user_id=UUID(meta.user_id),
                query=meta.query,
                origin=meta.origin.model_dump(mode="json") if meta.origin else None,
                idempotency_key=idempotency_key,
                created_at=_parse_iso(meta.ts),
                updated_at=_parse_iso(updated_at),
            )
            .on_conflict_do_update(
                index_elements=[SessionRecordORM.id, SessionRecordORM.vault_id],
                set_={
                    "user_id": UUID(meta.user_id),
                    "query": meta.query,
                    "origin": meta.origin.model_dump(mode="json")
                    if meta.origin
                    else None,
                    "created_at": _parse_iso(meta.ts),
                    "updated_at": _parse_iso(updated_at),
                },
            )
        )
        await self.session.execute(stmt)

    async def touch_updated(
        self, vault_id: UUID, session_id: str, updated_at: str
    ) -> None:
        await self.session.execute(
            update(SessionRecordORM)
            .where(
                SessionRecordORM.vault_id == vault_id,
                SessionRecordORM.id == session_id,
            )
            .values(updated_at=_parse_iso(updated_at))
        )

    async def count_overviews(
        self, vault_id: UUID, *, user_id: str | None = None
    ) -> int:
        stmt = (
            select(func.count())
            .select_from(SessionRecordORM)
            .where(SessionRecordORM.vault_id == vault_id)
        )
        if user_id is not None:
            stmt = stmt.where(SessionRecordORM.user_id == UUID(user_id))
        return (await self.session.scalar(stmt)) or 0

    async def list_overviews(
        self,
        vault_id: UUID,
        *,
        user_id: str | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> list[SessionOverview]:
        """List session overviews from the DB index, newest first."""
        stmt = select(SessionRecordORM).where(SessionRecordORM.vault_id == vault_id)
        if user_id is not None:
            stmt = stmt.where(SessionRecordORM.user_id == UUID(user_id))
        result = await self.session.execute(
            stmt.order_by(SessionRecordORM.updated_at.desc())
            .offset(offset)
            .limit(limit)
        )
        return [SessionOverview.model_validate(row) for row in result.scalars().all()]

    @staticmethod
    def find_meta(events: list[SessionEvent]) -> MetaEvent | None:
        """Return the session's MetaEvent, or None if missing/malformed."""
        for event in events:
            if isinstance(event, MetaEvent):
                return event
        return None

    @staticmethod
    def find_exchange(
        events: list[SessionEvent], exchange_id: str
    ) -> ExchangeEvent | None:
        """Return the ExchangeEvent with this exId, or None if missing."""
        for event in events:
            if isinstance(event, ExchangeEvent) and event.exId == exchange_id:
                return event
        return None
