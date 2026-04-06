"""Proposal service: business logic for proposal review workflows."""

import logging
from pathlib import Path

from absurd_sdk import AsyncAbsurd
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.core.brain import load_config
from great_minds.core.brains import _ingester as ingester
from great_minds.core.brains.schemas import Brain
from great_minds.core.proposals.models import SourceProposal
from great_minds.core.storage import LocalStorage
from great_minds.core.tasks import spawn_compile

log = logging.getLogger(__name__)


class ProposalService:
    """Handles proposal approval and rejection workflows."""

    async def approve(
        self,
        proposal: SourceProposal,
        brain: Brain,
        absurd: AsyncAbsurd,
        session: AsyncSession,
    ) -> None:
        """Ingest approved proposal content into the brain and trigger compilation."""
        content = Path(proposal.storage_path).read_text(encoding="utf-8")
        storage = LocalStorage(Path(brain.storage_root))
        config = load_config(storage)

        kwargs: dict[str, str] = {}
        if proposal.title:
            kwargs["title"] = proposal.title
        if proposal.author:
            kwargs["author"] = proposal.author
        ingester.ingest_document(storage, config, content, proposal.content_type, **kwargs)

        await spawn_compile(
            absurd, session,
            brain_id=brain.id,
            storage_root=brain.storage_root,
            label=brain.slug,
            brain_kind=brain.kind,
        )

    def reject(self, proposal: SourceProposal) -> None:
        """Clean up stored content for a rejected proposal."""
        path = Path(proposal.storage_path)
        if path.exists():
            path.unlink()
