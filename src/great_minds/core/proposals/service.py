"""Proposal service: business logic for proposal review workflows."""

import logging
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID

from absurd_sdk import AsyncAbsurd

from great_minds.core.brain import load_config
from great_minds.core import ingester
from great_minds.core.brains.schemas import Brain
from great_minds.core.proposals.models import ProposalStatus, SourceProposal
from great_minds.core.proposals.repository import ProposalRepository
from great_minds.core.settings import Settings
from great_minds.core.storage import Storage
from great_minds.core.workers import spawn_compile

log = logging.getLogger(__name__)


class ProposalService:
    """Handles proposal CRUD and review workflows."""

    def __init__(self, repo: ProposalRepository, settings: Settings) -> None:
        self.repo = repo
        self.data_dir = settings.data_dir

    async def _commit(self) -> None:
        await self.repo.session.commit()

    async def create(
        self,
        brain_id: UUID,
        user_id: UUID,
        content: str,
        content_type: str,
        title: str | None,
        author: str | None,
    ) -> SourceProposal:
        proposal = await self.repo.create(
            brain_id=brain_id,
            user_id=user_id,
            content_type=content_type,
            title=title,
            author=author,
            storage_path="",
        )

        storage_path = f"{self.data_dir}/proposals/{proposal.id}.md"
        proposal.storage_path = storage_path

        path = Path(storage_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")

        await self._commit()
        await self.repo.refresh(proposal)
        return proposal

    async def list_for_brain(
        self,
        brain_id: UUID,
        *,
        status: ProposalStatus | None = None,
    ) -> list[SourceProposal]:
        return await self.repo.list_for_brain(brain_id, status=status)

    async def get(self, proposal_id: UUID, brain_id: UUID) -> SourceProposal | None:
        return await self.repo.get(proposal_id, brain_id)

    async def review(
        self,
        proposal: SourceProposal,
        reviewer_id: UUID,
        new_status: ProposalStatus,
        brain: Brain,
        storage: Storage,
        absurd: AsyncAbsurd,
    ) -> SourceProposal:
        proposal.status = new_status
        proposal.reviewed_by = reviewer_id
        proposal.reviewed_at = datetime.now(UTC)

        if new_status == ProposalStatus.APPROVED:
            await self._approve(proposal, brain, storage, absurd)

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
        absurd: AsyncAbsurd,
    ) -> None:
        """Ingest approved proposal content into the brain and trigger compilation."""
        content = Path(proposal.storage_path).read_text(encoding="utf-8")
        config = load_config(storage)

        kwargs: dict[str, str] = {}
        if proposal.title:
            kwargs["title"] = proposal.title
        if proposal.author:
            kwargs["author"] = proposal.author
        ingester.ingest_document(
            storage, config, content, proposal.content_type, **kwargs
        )

        await spawn_compile(
            absurd,
            self.repo.session,
            brain_id=brain.id,
            data_dir=self.data_dir,
            label=brain.name,
        )

    def _reject(self, proposal: SourceProposal) -> None:
        """Clean up stored content for a rejected proposal."""
        path = Path(proposal.storage_path)
        if path.exists():
            path.unlink()
