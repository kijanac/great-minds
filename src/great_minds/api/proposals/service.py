"""Proposal service: business logic for proposal review workflows."""

import logging
from pathlib import Path

from great_minds.api.brains.models import Brain as BrainModel
from great_minds.api.brains.service import BrainService
from great_minds.api.proposals.models import SourceProposal

log = logging.getLogger(__name__)


class ProposalService:
    """Handles proposal approval and rejection workflows."""

    def __init__(self, brain_service: BrainService) -> None:
        self.brain_service = brain_service

    async def approve(self, proposal: SourceProposal, brain_row: BrainModel) -> None:
        """Ingest approved proposal content into the brain and trigger compilation."""
        content = Path(proposal.storage_path).read_text(encoding="utf-8")
        brain_instance = self.brain_service.get_instance(brain_row)

        kwargs: dict[str, str] = {}
        if proposal.title:
            kwargs["title"] = proposal.title
        if proposal.author:
            kwargs["author"] = proposal.author
        brain_instance.ingest_document(content, proposal.content_type, **kwargs)

        manager = self.brain_service.get_task_manager(brain_row)
        await manager.compile()

    def reject(self, proposal: SourceProposal) -> None:
        """Clean up stored content for a rejected proposal."""
        path = Path(proposal.storage_path)
        if path.exists():
            path.unlink()
