"""Auth repository: database operations for codes, tokens, and API keys."""

from datetime import UTC, datetime, timedelta
from uuid import UUID

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.core.auth.models import ApiKey, AuthCode, RefreshToken
from great_minds.core.crypto import hash_api_key, hash_code, hash_refresh_token
from great_minds.core.settings import Settings
from great_minds.core.users.models import User


class AuthRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def store_auth_code(
        self, email: str, code: str, settings: Settings
    ) -> AuthCode:
        await self.session.execute(
            update(AuthCode)
            .where(AuthCode.email == email, AuthCode.used == False)
            .values(used=True)
        )
        auth_code = AuthCode(
            email=email,
            code_hash=hash_code(code),
            expires_at=datetime.now(UTC)
            + timedelta(minutes=settings.auth_code_expiry_minutes),
        )
        self.session.add(auth_code)
        return auth_code

    async def verify_auth_code(self, email: str, code: str) -> bool:
        now = datetime.now(UTC)
        code_h = hash_code(code)
        result = await self.session.execute(
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

    async def store_refresh_token(
        self, user_id: UUID, raw_token: str, settings: Settings
    ) -> RefreshToken:
        rt = RefreshToken(
            user_id=user_id,
            token_hash=hash_refresh_token(raw_token),
            expires_at=datetime.now(UTC)
            + timedelta(days=settings.jwt_refresh_expiry_days),
        )
        self.session.add(rt)
        return rt

    async def validate_refresh_token(self, raw_token: str) -> RefreshToken | None:
        now = datetime.now(UTC)
        token_h = hash_refresh_token(raw_token)
        result = await self.session.execute(
            select(RefreshToken).where(
                RefreshToken.token_hash == token_h,
                RefreshToken.revoked == False,
                RefreshToken.expires_at > now,
            )
        )
        return result.scalar_one_or_none()

    async def resolve_api_key(self, raw_key: str) -> User | None:
        """O(1) lookup by SHA-256 hash."""
        key_h = hash_api_key(raw_key)
        result = await self.session.execute(
            select(User)
            .join(ApiKey, ApiKey.user_id == User.id)
            .where(
                ApiKey.key_hash == key_h,
                ApiKey.revoked == False,
            )
        )
        return result.scalar_one_or_none()

    async def store_api_key(self, user_id: UUID, raw_key: str, label: str) -> ApiKey:
        api_key = ApiKey(
            user_id=user_id,
            key_hash=hash_api_key(raw_key),
            label=label,
        )
        self.session.add(api_key)
        await self.session.flush()
        await self.session.refresh(api_key)
        return api_key

    async def revoke_api_key(self, key_id: UUID, user_id: UUID) -> bool:
        api_key = await self.session.get(ApiKey, key_id)
        if api_key is None or api_key.user_id != user_id:
            return False
        api_key.revoked = True
        return True
