"""Proposal service: business logic for proposal review workflows.

Handles staging (create) and lifecycle (list, get, review). Content
rendering happens upstream — callers pre-render markdown and pass it
to ``create()`` so the service stays agnostic to content source.
"""

import logging
from uuid import UUID

from great_minds.core.compile_intents.repository import CompileIntentRepository
from great_minds.core.documents.service import SourceDocumentService
from great_minds.core.pagination import Page, PageParams, create_page
from great_minds.core.paths import proposal_staging_path
from great_minds.core.proposals.errors import (
    ProposalAlreadyReviewed,
    ProposalNotFound,
)
from great_minds.core.proposals.models import ProposalStatus
from great_minds.core.proposals.repository import ProposalRepository
from great_minds.core.proposals.schemas import (
    Proposal,
    ProposalCreate,
    ProposalOverview,
    ReviewTarget,
)
from great_minds.core.storage import Storage

log = logging.getLogger(__name__)


class ProposalService:
    def __init__(
        self,
        repo: ProposalRepository,
        doc_service: SourceDocumentService,
        intent_repo: CompileIntentRepository,
        proposals_storage: Storage,
    ) -> None:
        self.repo = repo
        self.doc_service = doc_service
        self.intent_repo = intent_repo
        self.proposals_storage = proposals_storage

    async def _commit(self) -> None:
        await self.repo.session.commit()

    async def create(
        self,
        vault_id: UUID,
        user_id: UUID,
        data: ProposalCreate,
    ) -> Proposal:
        """Stage a pre-rendered proposal. Caller pre-computes ``rendered``
        and ``dest_path`` — this method handles DB insert + file write.

        For normal (typed-in) proposals the caller uses
        ``build_document`` from ``core.documents.builder``.
        For session promotions the caller uses
        ``render_session_exchange_source`` from ``core.sessions.service``.
        """
        proposal = await self.repo.create(
            vault_id=vault_id,
            user_id=user_id,
            content_type=data.content_type,
            title=data.title,
            author=data.author,
            dest_path=data.dest_path,
        )

        await self.proposals_storage.write(
            proposal_staging_path(proposal.id), data.rendered
        )

        await self._commit()
        return proposal

    async def list_for_vault(
        self,
        vault_id: UUID,
        *,
        pagination: PageParams,
        status: ProposalStatus | None = None,
    ) -> Page[ProposalOverview]:
        proposals = await self.repo.list_for_vault(
            vault_id,
            status=status,
            limit=pagination.limit,
            offset=pagination.offset,
        )
        total = await self.repo.count_for_vault(vault_id, status=status)
        return create_page(proposals, pagination, total)

    async def get_for_vault(self, vault_id: UUID, proposal_id: UUID) -> Proposal | None:
        return await self.repo.get_for_vault(vault_id, proposal_id)

    async def find_pending_for_dest(
        self, vault_id: UUID, dest_path: str
    ) -> Proposal | None:
        return await self.repo.find_pending_for_dest(vault_id, dest_path)

    async def review(
        self,
        vault_id: UUID,
        proposal_id: UUID,
        new_status: ReviewTarget,
        storage: Storage,
    ) -> Proposal:
        """Review a pending proposal. Approve promotes it into the vault corpus;
        reject cleans up the staged content.

        Raises ProposalNotFound if no such proposal exists, or
        ProposalAlreadyReviewed if it is no longer PENDING.
        """
        proposal = await self.repo.get_for_vault(vault_id, proposal_id)
        if proposal is None:
            raise ProposalNotFound(str(proposal_id))
        if proposal.status != ProposalStatus.PENDING:
            raise ProposalAlreadyReviewed(str(proposal_id))

        match new_status:
            case ProposalStatus.APPROVED:
                await self._approve(proposal, storage)
            case ProposalStatus.REJECTED:
                await self._reject(proposal)

        await self.repo.set_status(vault_id, proposal.id, new_status)
        await self._commit()
        result = await self.repo.get_for_vault(vault_id, proposal.id)
        if result is None:
            raise RuntimeError(f"reviewed proposal {proposal.id} not found")
        return result

    async def _approve(
        self,
        proposal: Proposal,
        storage: Storage,
    ) -> None:
        """Write staged content to dest_path, index it, and link the
        resulting document_id back to the proposal."""
        path = proposal_staging_path(proposal.id)
        rendered = await self.proposals_storage.read(path)
        await storage.write(proposal.dest_path, rendered)
        document_id = await self.doc_service.index(
            proposal.vault_id, proposal.dest_path, rendered
        )
        await self.repo.set_document_id(proposal.id, document_id)
        await self.intent_repo.ensure_pending(proposal.vault_id)

    async def _reject(self, proposal: Proposal) -> None:
        """Clean up staged content for a rejected proposal."""
        await self.proposals_storage.delete(proposal_staging_path(proposal.id))
