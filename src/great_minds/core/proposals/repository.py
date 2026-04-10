"""Proposal repository: database operations."""

from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.core.proposals.models import ProposalStatus, SourceProposal


class ProposalRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def create(self, **kwargs) -> SourceProposal:
        proposal = SourceProposal(**kwargs)
        self.session.add(proposal)
        await self.session.flush()
        return proposal

    async def list_for_brain(
        self,
        brain_id: UUID,
        *,
        status: ProposalStatus | None = None,
    ) -> list[SourceProposal]:
        query = (
            select(SourceProposal)
            .where(SourceProposal.brain_id == brain_id)
            .order_by(SourceProposal.created_at.desc())
        )
        if status is not None:
            query = query.where(SourceProposal.status == status)

        result = await self.session.execute(query)
        return list(result.scalars())

    async def get(self, proposal_id: UUID, brain_id: UUID) -> SourceProposal | None:
        result = await self.session.execute(
            select(SourceProposal).where(
                SourceProposal.id == proposal_id,
                SourceProposal.brain_id == brain_id,
            )
        )
        return result.scalar_one_or_none()

    async def refresh(self, proposal: SourceProposal) -> None:
        await self.session.refresh(proposal)
