"""Proposal repository: database operations."""

from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.api.brains.models import BrainMembership
from great_minds.api.proposals.models import ProposalStatus, SourceProposal


async def create_proposal(session: AsyncSession, **kwargs) -> SourceProposal:
    proposal = SourceProposal(**kwargs)
    session.add(proposal)
    await session.flush()
    return proposal


async def list_proposals(
    session: AsyncSession,
    user_id: UUID,
    *,
    brain_id: UUID | None = None,
    status: ProposalStatus | None = None,
) -> list[SourceProposal]:
    query = (
        select(SourceProposal)
        .join(BrainMembership, BrainMembership.brain_id == SourceProposal.brain_id)
        .where(BrainMembership.user_id == user_id)
        .order_by(SourceProposal.created_at.desc())
    )
    if brain_id is not None:
        query = query.where(SourceProposal.brain_id == brain_id)
    if status is not None:
        query = query.where(SourceProposal.status == status)

    result = await session.execute(query)
    return list(result.scalars())


async def get_authorized_proposal(session: AsyncSession, proposal_id: UUID, user_id: UUID) -> SourceProposal | None:
    result = await session.execute(
        select(SourceProposal)
        .join(BrainMembership, BrainMembership.brain_id == SourceProposal.brain_id)
        .where(SourceProposal.id == proposal_id, BrainMembership.user_id == user_id)
    )
    return result.scalar_one_or_none()
