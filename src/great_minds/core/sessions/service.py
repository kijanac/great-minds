"""Session workflow service."""

from collections import defaultdict
from uuid import UUID

from great_minds.core.documents.builder import build_document
from great_minds.core.pagination import Page, PageParams, create_page
from great_minds.core.storage import Storage

from .repository import SessionRepository, now_iso
from .schemas import (
    BtwEvent,
    BtwInput,
    ExchangeEvent,
    ExchangeInput,
    MetaEvent,
    SessionEvent,
    SessionOrigin,
    SessionOverview,
)


class SessionService:
    """Session event-log workflows for one vault storage scope."""

    def __init__(self, repo: SessionRepository) -> None:
        self.repo = repo

    @property
    def storage(self) -> Storage:
        return self.repo.storage

    async def create_session(
        self,
        vault_id: UUID,
        session_id: str,
        exchange: ExchangeInput,
        *,
        origin: SessionOrigin | None = None,
        user_id: str,
    ) -> str:
        """Create a new session with the first exchange."""
        await self.repo.mkdir()

        meta = MetaEvent(
            id=session_id,
            query=exchange.query,
            ts=now_iso(),
            user_id=user_id,
            origin=origin,
        )
        await self.repo.append_event(session_id, meta)

        ex = ExchangeEvent(
            exId=exchange.id,
            query=exchange.query,
            thinking=exchange.thinking,
            answer=exchange.answer,
            ts=now_iso(),
        )
        await self.repo.append_event(session_id, ex)
        await self.repo.upsert_overview(vault_id, meta, updated_at=ex.ts)
        await self.repo.session.commit()

        await self._rebuild_md(session_id)
        return f"sessions/{session_id}.jsonl"

    async def append_exchange(
        self,
        vault_id: UUID,
        session_id: str,
        exchange: ExchangeInput,
    ) -> str:
        """Append a follow-up exchange to an existing session."""
        ex = ExchangeEvent(
            exId=exchange.id,
            query=exchange.query,
            thinking=exchange.thinking,
            answer=exchange.answer,
            ts=now_iso(),
        )
        await self.repo.append_event(session_id, ex)
        await self.repo.touch_updated(vault_id, session_id, ex.ts)
        await self.repo.session.commit()
        await self._rebuild_md(session_id)
        return f"sessions/{session_id}.jsonl"

    async def append_btw(
        self,
        vault_id: UUID,
        session_id: str,
        btw: BtwInput,
    ) -> str:
        """Append a BTW thread to an existing session."""
        event = BtwEvent(
            exId=btw.exchangeId,
            quote=btw.quote,
            blockOffset=btw.blockOffset,
            context=btw.context,
            exchanges=btw.exchanges,
            ts=now_iso(),
        )
        await self.repo.append_event(session_id, event)
        await self.repo.touch_updated(vault_id, session_id, event.ts)
        await self.repo.session.commit()
        await self._rebuild_md(session_id)
        return f"sessions/{session_id}.jsonl"

    async def load_events(self, session_id: str) -> list[SessionEvent]:
        return await self.repo.load_events(session_id)

    async def list_sessions(
        self,
        vault_id: UUID,
        *,
        user_id: str | None = None,
        pagination: PageParams,
    ) -> Page[SessionOverview]:
        """List all sessions with metadata. Sorted by last activity."""
        total = await self.repo.count_overviews(vault_id, user_id=user_id)
        results = await self.repo.list_overviews(
            vault_id,
            user_id=user_id,
            limit=pagination.limit,
            offset=pagination.offset,
        )
        return create_page(results, pagination, total)

    async def _rebuild_md(self, session_id: str) -> None:
        events = await self.repo.load_events(session_id)
        await self.repo.write_markdown(session_id, self._render_markdown(events))

    @staticmethod
    def find_meta(events: list[SessionEvent]) -> MetaEvent | None:
        return SessionRepository.find_meta(events)

    @staticmethod
    def find_exchange(
        events: list[SessionEvent], exchange_id: str
    ) -> ExchangeEvent | None:
        return SessionRepository.find_exchange(events, exchange_id)

    @staticmethod
    def _render_markdown(events: list[SessionEvent]) -> str:
        """Render event log as human-readable markdown.

        Each BTW reply writes a fresh BtwEvent with the full thread history,
        so multiple BtwEvents per (exId, anchor) accumulate in the JSONL.
        Dedup to the latest by ts before rendering so the markdown shows one
        block per BTW thread, not N progressively-longer blocks.
        """
        exchanges: list[ExchangeEvent] = []
        latest_btw: dict[tuple[str, str], BtwEvent] = {}

        for event in events:
            if isinstance(event, ExchangeEvent):
                exchanges.append(event)
            elif isinstance(event, BtwEvent):
                key = (event.exId, event.quote)
                existing = latest_btw.get(key)
                if existing is None or event.ts > existing.ts:
                    latest_btw[key] = event

        btws_by_ex: dict[str, list[BtwEvent]] = defaultdict(list)
        for btw in latest_btw.values():
            btws_by_ex[btw.exId].append(btw)

        parts: list[str] = []
        for i, ex in enumerate(exchanges):
            if i > 0:
                parts.append("\n---\n\n")
            parts.append(f"# {ex.query}\n\n")

            for block in ex.thinking:
                for src in block.sources:
                    parts.append(f"> `{src.label}`\n")
                parts.append(">\n")

            parts.append(ex.answer + "\n")

            for btw in btws_by_ex.get(ex.exId, []):
                short = btw.quote[:60] + "..." if len(btw.quote) > 60 else btw.quote
                parts.append(f'\n> **BTW** re: "{short}"\n>\n')
                for inner in btw.exchanges:
                    parts.append(f"> *{inner.query}*\n>\n")
                    parts.append(f"> {inner.answer}\n>\n")

        return "".join(parts).rstrip() + "\n"

    @staticmethod
    def session_exchange_build_args(
        *,
        session_id: str,
        exchange: ExchangeEvent,
        session_origin: SessionOrigin | None,
    ) -> dict:
        """Build kwargs for ``build_document`` / ``IngestService.ingest_session_exchange``.

        Provenance fields are passed individually so they land in typed
        columns. Title is intentionally absent — extract owns titling.
        """
        args: dict = {
            "content": exchange.answer,
            "source_type": "session",
            "origin": "session-exchange",
            "session_id": session_id,
            "exchange_id": exchange.exId,
            "session_query": exchange.query,
        }
        if session_origin is not None:
            args["source_doc_path"] = session_origin.doc_path
            if session_origin.anchor:
                args["source_anchor"] = session_origin.anchor
            if session_origin.paragraph_index is not None:
                args["source_paragraph_index"] = session_origin.paragraph_index
        return args

    @classmethod
    def render_session_exchange_source(
        cls,
        *,
        session_id: str,
        exchange: ExchangeEvent,
        session_origin: SessionOrigin | None,
    ) -> str:
        """Build the full markdown (frontmatter + body) for a promoted exchange."""
        return build_document(
            **cls.session_exchange_build_args(
                session_id=session_id,
                exchange=exchange,
                session_origin=session_origin,
            ),
        )
