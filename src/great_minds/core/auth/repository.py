"""Auth repository: database operations for codes, tokens, and API keys."""

from datetime import UTC, datetime, timedelta
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.core.auth.models import ApiKey, AuthCode, RefreshToken
from great_minds.core.crypto import hash_api_key, hash_code, hash_refresh_token
from great_minds.core.settings import Settings
from great_minds.core.users.models import User


async def store_auth_code(session: AsyncSession, email: str, code: str, settings: Settings) -> AuthCode:
    auth_code = AuthCode(
        email=email,
        code_hash=hash_code(code),
        expires_at=datetime.now(UTC) + timedelta(minutes=settings.auth_code_expiry_minutes),
    )
    session.add(auth_code)
    return auth_code


async def verify_auth_code(session: AsyncSession, email: str, code: str) -> bool:
    now = datetime.now(UTC)
    code_h = hash_code(code)
    result = await session.execute(
        select(AuthCode).where(
            AuthCode.email == email,
            AuthCode.code_hash == code_h,
            AuthCode.used == False,
            AuthCode.expires_at > now,
        )
    )
    auth_code = result.scalar_one_or_none()
    if auth_code is None:
        return False
    auth_code.used = True
    return True


async def store_refresh_token(session: AsyncSession, user_id: UUID, raw_token: str, settings: Settings) -> RefreshToken:
    rt = RefreshToken(
        user_id=user_id,
        token_hash=hash_refresh_token(raw_token),
        expires_at=datetime.now(UTC) + timedelta(days=settings.jwt_refresh_expiry_days),
    )
    session.add(rt)
    return rt


async def validate_refresh_token(session: AsyncSession, raw_token: str) -> RefreshToken | None:
    now = datetime.now(UTC)
    token_h = hash_refresh_token(raw_token)
    result = await session.execute(
        select(RefreshToken).where(
            RefreshToken.token_hash == token_h,
            RefreshToken.revoked == False,
            RefreshToken.expires_at > now,
        )
    )
    return result.scalar_one_or_none()


async def resolve_api_key(session: AsyncSession, raw_key: str) -> User | None:
    """O(1) lookup by SHA-256 hash."""
    key_h = hash_api_key(raw_key)
    result = await session.execute(
        select(User).join(ApiKey, ApiKey.user_id == User.id).where(
            ApiKey.key_hash == key_h,
            ApiKey.revoked == False,
        )
    )
    return result.scalar_one_or_none()
