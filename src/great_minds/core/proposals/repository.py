"""Proposal repository: database operations."""

from uuid import UUID

from sqlalchemy import Select, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.core.proposals.models import ProposalORM, ProposalStatus
from great_minds.core.proposals.schemas import Proposal, ProposalOverview


class ProposalRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def create(self, **kwargs) -> Proposal:
        proposal = ProposalORM(**kwargs)
        self.session.add(proposal)
        await self.session.flush()
        await self.session.refresh(proposal)
        return Proposal.model_validate(proposal)

    async def list_for_vault(
        self,
        vault_id: UUID,
        *,
        status: ProposalStatus | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> list[ProposalOverview]:
        query = (
            _proposal_query(vault_id, status=status)
            .order_by(ProposalORM.created_at.desc())
            .offset(offset)
            .limit(limit)
        )
        result = await self.session.execute(query)
        return [ProposalOverview.model_validate(r) for r in result.scalars()]

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

    async def get(self, proposal_id: UUID) -> Proposal | None:
        result = await self.session.execute(
            select(ProposalORM).where(ProposalORM.id == proposal_id)
        )
        row = result.scalar_one_or_none()
        return Proposal.model_validate(row) if row else None

    async def find_pending_for_dest(
        self, vault_id: UUID, dest_path: str
    ) -> Proposal | None:
        """Return the pending proposal targeting ``dest_path`` for this vault.

        Backed by the partial unique index ``(vault_id, dest_path)`` for
        ``status = 'PENDING'``, so at most one row matches.
        """
        result = await self.session.execute(
            select(ProposalORM).where(
                ProposalORM.vault_id == vault_id,
                ProposalORM.dest_path == dest_path,
                ProposalORM.status == ProposalStatus.PENDING,
            )
        )
        row = result.scalar_one_or_none()
        return Proposal.model_validate(row) if row else None

    async def set_status(
        self,
        proposal_id: UUID,
        status: ProposalStatus,
    ) -> None:
        await self.session.execute(
            update(ProposalORM)
            .where(ProposalORM.id == proposal_id)
            .values(status=status)
        )


def _proposal_query(
    vault_id: UUID, *, status: ProposalStatus | None = None
) -> Select[tuple[ProposalORM]]:
    query = select(ProposalORM).where(ProposalORM.vault_id == vault_id)
    if status is not None:
        query = query.where(ProposalORM.status == status)
    return query
