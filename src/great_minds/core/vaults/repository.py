"""Vault repository: database operations."""

from uuid import UUID

from sqlalchemy import delete, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.core.vaults.models import (
    VaultORM,
    VaultMembership,
    MemberRole,
)
from great_minds.core.vaults.schemas import Vault, VaultWithRole, MemberWithEmail
from great_minds.core.users.models import User


class VaultRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get_by_id(self, vault_id: UUID) -> Vault | None:
        result = await self.session.execute(
            select(VaultORM).where(VaultORM.id == vault_id)
        )
        row = result.scalar_one_or_none()
        return Vault.model_validate(row) if row else None

    async def create_vault(
        self,
        name: str,
        owner_id: UUID,
        *,
        r2_bucket_name: str | None = None,
    ) -> Vault:
        vault = VaultORM(
            name=name,
            owner_id=owner_id,
            r2_bucket_name=r2_bucket_name,
        )
        self.session.add(vault)
        await self.session.flush()
        await self.upsert_membership(vault.id, owner_id, MemberRole.OWNER)
        await self.session.refresh(vault)
        return Vault.model_validate(vault)

    async def list_owned_by(self, user_id: UUID) -> list[Vault]:
        """All vaults where ``user_id`` is the owner. Unpaginated."""
        result = await self.session.execute(
            select(VaultORM)
            .where(VaultORM.owner_id == user_id)
            .order_by(VaultORM.created_at.desc())
        )
        return [Vault.model_validate(row) for row in result.scalars().all()]

    async def delete_vault(self, vault_id: UUID) -> None:
        """Drop the vault row and explicitly clean up non-cascading rows.

        ``idea_embeddings`` has no FK to vaults so it doesn't cascade —
        delete it explicitly first. The vault row delete cascades to
        memberships, documents (→ tags), proposals, tasks, search_index,
        topics (→ topic_membership, topic_links, topic_related, backlinks).
        Caller commits.
        """
        await self.session.execute(
            text("DELETE FROM idea_embeddings WHERE vault_id = :bid"),
            {"bid": str(vault_id)},
        )
        await self.session.execute(delete(VaultORM).where(VaultORM.id == vault_id))

    async def list_user_vaults(
        self, user_id: UUID, *, limit: int | None = 50, offset: int = 0
    ) -> list[VaultWithRole]:
        stmt = (
            select(VaultORM, VaultMembership.role)
            .join(VaultMembership, VaultMembership.vault_id == VaultORM.id)
            .where(VaultMembership.user_id == user_id)
            .order_by(VaultORM.created_at.desc())
            .offset(offset)
        )
        if limit is not None:
            stmt = stmt.limit(limit)
        result = await self.session.execute(stmt)
        return [
            VaultWithRole(vault=Vault.model_validate(vault), role=role)
            for vault, role in result.all()
        ]

    async def count_user_vaults(self, user_id: UUID) -> int:
        return (
            await self.session.scalar(
                select(func.count())
                .select_from(VaultORM)
                .join(VaultMembership, VaultMembership.vault_id == VaultORM.id)
                .where(VaultMembership.user_id == user_id)
            )
        ) or 0

    async def is_member(self, vault_id: UUID, user_id: UUID) -> bool:
        result = await self.session.execute(
            select(VaultMembership.id).where(
                VaultMembership.vault_id == vault_id,
                VaultMembership.user_id == user_id,
            )
        )
        return result.scalar_one_or_none() is not None

    async def get_role(self, vault_id: UUID, user_id: UUID) -> MemberRole | None:
        result = await self.session.execute(
            select(VaultMembership.role).where(
                VaultMembership.vault_id == vault_id,
                VaultMembership.user_id == user_id,
            )
        )
        return result.scalar_one_or_none()

    async def get_member_count(self, vault_id: UUID) -> int:
        result = await self.session.execute(
            select(func.count()).where(VaultMembership.vault_id == vault_id)
        )
        return result.scalar_one()

    async def list_members(
        self, vault_id: UUID, *, limit: int = 50, offset: int = 0
    ) -> list[MemberWithEmail]:
        result = await self.session.execute(
            select(
                VaultMembership.user_id,
                VaultMembership.role,
                User.email,
            )
            .join(User, User.id == VaultMembership.user_id)
            .where(VaultMembership.vault_id == vault_id)
            .order_by(User.email)
            .offset(offset)
            .limit(limit)
        )
        return [
            MemberWithEmail(user_id=user_id, role=role, email=email)
            for user_id, role, email in result.all()
        ]

    async def upsert_membership(
        self, vault_id: UUID, user_id: UUID, role: MemberRole
    ) -> VaultMembership:
        result = await self.session.execute(
            select(VaultMembership).where(
                VaultMembership.vault_id == vault_id,
                VaultMembership.user_id == user_id,
            )
        )
        membership = result.scalar_one_or_none()
        if membership is None:
            membership = VaultMembership(vault_id=vault_id, user_id=user_id, role=role)
            self.session.add(membership)
        else:
            membership.role = role
        return membership

    async def delete_membership(self, vault_id: UUID, user_id: UUID) -> bool:
        result = await self.session.execute(
            select(VaultMembership).where(
                VaultMembership.vault_id == vault_id,
                VaultMembership.user_id == user_id,
            )
        )
        membership = result.scalar_one_or_none()
        if membership is None:
            return False
        await self.session.delete(membership)
        return True
