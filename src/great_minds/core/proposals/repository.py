"""Proposal repository: database operations."""

from uuid import UUID

from sqlalchemy import Select, func, select
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

    async def list_for_vault(
        self,
        vault_id: UUID,
        *,
        status: ProposalStatus | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> list[SourceProposal]:
        query = (
            _proposal_query(vault_id, status=status)
            .order_by(SourceProposal.created_at.desc())
            .offset(offset)
            .limit(limit)
        )
        result = await self.session.execute(query)
        return list(result.scalars())

    async def count_for_vault(
        self,
        vault_id: UUID,
        *,
        status: ProposalStatus | None = None,
    ) -> int:
        filtered = _proposal_query(vault_id, status=status).subquery()
        return (
            await self.session.scalar(select(func.count()).select_from(filtered))
        ) or 0

    async def get(self, proposal_id: UUID, vault_id: UUID) -> SourceProposal | None:
        result = await self.session.execute(
            select(SourceProposal).where(
                SourceProposal.id == proposal_id,
                SourceProposal.vault_id == vault_id,
            )
        )
        return result.scalar_one_or_none()

    async def find_pending_for_dest(
        self, vault_id: UUID, dest_path: str
    ) -> SourceProposal | None:
        """Return the pending proposal targeting ``dest_path`` for this vault.

        Backed by the partial unique index ``(vault_id, dest_path)`` for
        ``status = 'PENDING'``, so at most one row matches.
        """
        result = await self.session.execute(
            select(SourceProposal).where(
                SourceProposal.vault_id == vault_id,
                SourceProposal.dest_path == dest_path,
                SourceProposal.status == ProposalStatus.PENDING,
            )
        )
        return result.scalar_one_or_none()

    async def refresh(self, proposal: SourceProposal) -> None:
        await self.session.refresh(proposal)


def _proposal_query(
    vault_id: UUID, *, status: ProposalStatus | None = None
) -> Select[tuple[SourceProposal]]:
    query = select(SourceProposal).where(SourceProposal.vault_id == vault_id)
    if status is not None:
        query = query.where(SourceProposal.status == status)
    return query
