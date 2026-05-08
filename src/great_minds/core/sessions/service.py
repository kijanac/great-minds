"""Session workflow service."""

from collections import defaultdict
from uuid import UUID

from openai import AsyncOpenAI

from great_minds.core.documents.builder import build_document
from great_minds.core.llm import QUERY_MODEL
from great_minds.core.llm.client import api_call, extract_content
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


_SESSION_TITLE_SYSTEM = (
    "You generate concise titles for distilled Q&A excerpts that have "
    "been promoted to a knowledge base. Output a 3-7 word noun phrase "
    "in Title Case, no question marks, no leading articles, no quotes. "
    "Output ONLY the title text — no preamble, no explanation."
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
        await self.repo.upsert_overview(vault_id, meta, updated=ex.ts)
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
            anchor=btw.anchor,
            paragraph=btw.paragraph,
            pi=btw.paragraphIndex,
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
                key = (event.exId, event.anchor)
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
                short = btw.anchor[:60] + "..." if len(btw.anchor) > 60 else btw.anchor
                parts.append(f'\n> **BTW** re: "{short}"\n>\n')
                for inner in btw.exchanges:
                    parts.append(f"> *{inner.query}*\n>\n")
                    parts.append(f"> {inner.answer}\n>\n")

        return "".join(parts).rstrip() + "\n"

    @staticmethod
    async def generate_session_title(
        client: AsyncOpenAI, query: str, answer: str
    ) -> str:
        """One-shot title for a promoted session exchange."""
        response = await api_call(
            client,
            model=QUERY_MODEL,
            messages=[
                {"role": "system", "content": _SESSION_TITLE_SYSTEM},
                {"role": "user", "content": f"Q: {query}\n\nA: {answer}"},
            ],
            temperature=0.4,
        )
        title = (extract_content(response) or "").strip().strip('"').strip()
        if not title:
            raise ValueError("LLM returned empty title")
        return title

    @staticmethod
    def session_exchange_build_args(
        *,
        session_id: str,
        exchange: ExchangeEvent,
        title: str,
        session_origin: SessionOrigin | None,
    ) -> dict:
        """Args dict shared by document rendering and direct ingest."""
        extras: dict[str, str] = {
            "source_session_id": session_id,
            "source_exchange_id": exchange.exId,
            "source_query": exchange.query,
        }
        if session_origin is not None:
            extras["source_doc_path"] = session_origin.doc_path
            if session_origin.anchor:
                extras["source_anchor"] = session_origin.anchor
            if session_origin.paragraph_index is not None:
                extras["source_paragraph_index"] = str(session_origin.paragraph_index)

        return dict(
            content=exchange.answer,
            content_type="sessions",
            source_type="user",
            title=title,
            origin="session-exchange",
            **extras,
        )

    @classmethod
    def render_session_exchange_source(
        cls,
        config: dict,
        *,
        session_id: str,
        exchange: ExchangeEvent,
        title: str,
        session_origin: SessionOrigin | None,
    ) -> str:
        """Build the full markdown (frontmatter + body) for a promoted exchange."""
        return build_document(
            config,
            **cls.session_exchange_build_args(
                session_id=session_id,
                exchange=exchange,
                title=title,
                session_origin=session_origin,
            ),
        )
