"""User service: provisioning and lifecycle."""

from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.core.brains.repository import create_personal_brain
from great_minds.core.users.models import User


async def provision_new_user(session: AsyncSession, user: User) -> None:
    """Set up resources for a newly created user (e.g. personal brain)."""
    await create_personal_brain(session, user)
