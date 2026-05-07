"""JSONL-backed session event repository."""

import json
import logging
from datetime import datetime, timezone

from pydantic import ValidationError

from great_minds.core.storage import Storage

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

    def __init__(self, storage: Storage) -> None:
        self.storage = storage

    async def mkdir(self) -> None:
        await self.storage.mkdir("sessions")

    async def append_event(self, session_id: str, event: SessionEvent) -> None:
        await self.storage.append(
            f"sessions/{session_id}.jsonl", json.dumps(event.model_dump()) + "\n"
        )

    async def write_markdown(self, session_id: str, markdown: str) -> None:
        await self.storage.write(f"sessions/{session_id}.md", markdown)

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

    async def list_overviews(
        self, *, user_id: str | None = None
    ) -> list[SessionOverview]:
        """List session overviews sorted by last activity descending."""
        results: list[SessionOverview] = []
        for path in await self.storage.glob("sessions/*.jsonl"):
            content = await self.storage.read(path)
            if content is None:
                continue
            lines = [line for line in content.strip().split("\n") if line.strip()]
            if not lines:
                continue

            try:
                raw_meta = json.loads(lines[0])
            except json.JSONDecodeError:
                continue
            if raw_meta.get("type") != EventType.META:
                continue

            try:
                meta = MetaEvent.model_validate(raw_meta)
            except ValidationError:
                continue

            if user_id is not None and meta.user_id != user_id:
                continue

            updated = meta.ts
            if len(lines) > 1:
                try:
                    last = json.loads(lines[-1])
                    updated = last.get("ts", meta.ts)
                except json.JSONDecodeError:
                    pass

            results.append(
                SessionOverview(
                    id=meta.id,
                    query=meta.query,
                    created=meta.ts,
                    updated=updated,
                    user_id=meta.user_id,
                    origin=meta.origin,
                )
            )

        results.sort(key=lambda s: s.updated, reverse=True)
        return results

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
