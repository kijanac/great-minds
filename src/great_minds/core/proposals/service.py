"""Proposal service: business logic for proposal review workflows."""

import logging
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID

from great_minds.core.brains.config import load_config
from great_minds.core.brains.schemas import Brain
from great_minds.core.compile_intents.repository import CompileIntentRepository
from great_minds.core.documents.service import DocumentService
from great_minds.core.documents.builder import build_document
from great_minds.core.sessions import render_session_exchange_source
from great_minds.core.text import slugify
from great_minds.core.pagination import Page, PageInfo, PageParams
from great_minds.core.paths import raw_path, session_exchange_path
from great_minds.core.proposals.models import ProposalStatus, SourceProposal
from great_minds.core.proposals.repository import ProposalRepository
from great_minds.core.proposals.schemas import Proposal
from great_minds.core.sessions import ExchangeEvent, SessionOrigin
from great_minds.core.settings import Settings
from great_minds.core.storage import Storage
from great_minds.core.telemetry import log_event

log = logging.getLogger(__name__)


class ProposalService:
    """Handles proposal CRUD and review workflows.

    Proposal storage holds the *fully rendered* source content
    (frontmatter + body) staged at create time. Approval becomes a
    direct write to ``dest_path`` plus a documents-table upsert and a
    compile intent — no second pass through the ingester at approve time.
    """

    def __init__(
        self,
        repo: ProposalRepository,
        doc_service: DocumentService,
        settings: Settings,
    ) -> None:
        self.repo = repo
        self.doc_service = doc_service
        self.data_dir = settings.data_dir

    async def _commit(self) -> None:
        await self.repo.session.commit()

    async def create(
        self,
        brain_id: UUID,
        user_id: UUID,
        storage: Storage,
        content: str,
        content_type: str,
        title: str | None,
        author: str | None,
    ) -> SourceProposal:
        """Create a typed-in proposal — body becomes a raw/{content_type}/<slug>.md."""
        slug_source = title or content_type
        filename = f"{slugify(slug_source)}.md"
        dest = raw_path(content_type, filename)

        config = await load_config(storage)
        kwargs: dict[str, str] = {}
        if title:
            kwargs["title"] = title
        if author:
            kwargs["author"] = author
        rendered = build_document(config, content, content_type, **kwargs)

        return await self._stage_and_persist(
            brain_id=brain_id,
            user_id=user_id,
            content_type=content_type,
            title=title,
            author=author,
            dest_path=dest,
            rendered=rendered,
        )

    async def create_session_promotion(
        self,
        brain_id: UUID,
        user_id: UUID,
        storage: Storage,
        *,
        session_id: str,
        exchange: ExchangeEvent,
        title: str,
        session_origin: SessionOrigin | None = None,
    ) -> SourceProposal:
        """Create a proposal whose source comes from a session exchange."""
        config = await load_config(storage)
        rendered = render_session_exchange_source(
            config,
            session_id=session_id,
            exchange=exchange,
            title=title,
            session_origin=session_origin,
        )
        dest = session_exchange_path(exchange.exId)

        return await self._stage_and_persist(
            brain_id=brain_id,
            user_id=user_id,
            content_type="sessions",
            title=title,
            author=None,
            dest_path=dest,
            rendered=rendered,
        )

    async def _stage_and_persist(
        self,
        *,
        brain_id: UUID,
        user_id: UUID,
        content_type: str,
        title: str | None,
        author: str | None,
        dest_path: str,
        rendered: str,
    ) -> SourceProposal:
        proposal = await self.repo.create(
            brain_id=brain_id,
            user_id=user_id,
            content_type=content_type,
            title=title,
            author=author,
            storage_path="",
            dest_path=dest_path,
        )

        storage_path = f"{self.data_dir}/proposals/{proposal.id}.md"
        proposal.storage_path = storage_path

        path = Path(storage_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(rendered, encoding="utf-8")

        await self._commit()
        await self.repo.refresh(proposal)
        return proposal

    async def list_for_brain(
        self,
        brain_id: UUID,
        *,
        status: ProposalStatus | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> list[SourceProposal]:
        return await self.repo.list_for_brain(
            brain_id, status=status, limit=limit, offset=offset
        )

    async def list_for_brain_page(
        self,
        brain_id: UUID,
        *,
        pagination: PageParams,
        status: ProposalStatus | None = None,
    ) -> Page[Proposal]:
        proposals = await self.repo.list_for_brain(
            brain_id,
            status=status,
            limit=pagination.limit,
            offset=pagination.offset,
        )
        total = await self.repo.count_for_brain(brain_id, status=status)
        return Page(
            items=[Proposal.model_validate(proposal) for proposal in proposals],
            pagination=PageInfo(
                limit=pagination.limit,
                offset=pagination.offset,
                total=total,
            ),
        )

    async def get(self, proposal_id: UUID, brain_id: UUID) -> SourceProposal | None:
        return await self.repo.get(proposal_id, brain_id)

    async def find_pending_for_dest(
        self, brain_id: UUID, dest_path: str
    ) -> SourceProposal | None:
        return await self.repo.find_pending_for_dest(brain_id, dest_path)

    async def review(
        self,
        proposal: SourceProposal,
        reviewer_id: UUID,
        new_status: ProposalStatus,
        brain: Brain,
        storage: Storage,
    ) -> SourceProposal:
        proposal.status = new_status
        proposal.reviewed_by = reviewer_id
        proposal.reviewed_at = datetime.now(UTC)

        if new_status == ProposalStatus.APPROVED:
            await self._approve(proposal, brain, storage)

        if new_status == ProposalStatus.REJECTED:
            self._reject(proposal)

        await self._commit()
        await self.repo.refresh(proposal)
        return proposal

    async def _approve(
        self,
        proposal: SourceProposal,
        brain: Brain,
        storage: Storage,
    ) -> None:
        """Write staged content to dest_path, index, and dispatch a compile."""
        rendered = Path(proposal.storage_path).read_text(encoding="utf-8")
        await storage.write(proposal.dest_path, rendered)
        await self.doc_service.index_raw_doc(
            brain.id, proposal.dest_path, rendered
        )

        intent_repo = CompileIntentRepository(self.repo.session)
        intent = await intent_repo.upsert_pending(brain.id)
        if intent is not None:
            log_event(
                "intent_created",
                intent_id=str(intent.id),
                brain_id=str(brain.id),
                trigger="proposal_approved",
            )

    def _reject(self, proposal: SourceProposal) -> None:
        """Clean up staged content for a rejected proposal."""
        path = Path(proposal.storage_path)
        if path.exists():
            path.unlink()
