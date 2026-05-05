"""Auth repository: database operations for codes, tokens, and API keys."""

from datetime import UTC, datetime, timedelta
from uuid import UUID

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.core.auth.models import ApiKeyORM, AuthCode, RefreshToken
from great_minds.core.auth.schemas import ApiKey as ApiKeySchema
from great_minds.core.crypto import hash_api_key, hash_code, hash_refresh_token
from great_minds.core.settings import Settings
from great_minds.core.users.schemas import User as UserSchema
from great_minds.core.users.models import UserORM


class AuthRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def store_auth_code(
        self, email: str, code: str, settings: Settings
    ) -> AuthCode:
        import logging
        log = logging.getLogger(__name__)
        await self.session.execute(
            update(AuthCode)
            .where(AuthCode.email == email, AuthCode.used == False)
            .values(used=True)
        )
        db_now = await self.session.scalar(func.now())
        code_hash = hash_code(code)
        auth_code = AuthCode(
            email=email,
            code_hash=code_hash,
            expires_at=db_now
            + timedelta(minutes=settings.auth_code_expiry_minutes),
        )
        self.session.add(auth_code)
        await self.session.flush()
        await self.session.commit()
        log.info("store_auth_code email=%s code_hash=%s expires=%s", email, code_hash, auth_code.expires_at)
        return auth_code

    async def verify_auth_code(self, email: str, code: str) -> bool:
        code_h = hash_code(code)
        db_now = await self.session.scalar(func.now())
        import logging
        log = logging.getLogger(__name__)
        log.info("verify_auth_code email=%s code_hash=%s db_now=%s", email, code_h, db_now)
        result = await self.session.execute(
            select(AuthCode).where(
                AuthCode.email == email,
                AuthCode.code_hash == code_h,
                AuthCode.used == False,
                AuthCode.expires_at > db_now,
            )
        )
        auth_code = result.scalar_one_or_none()
        if auth_code is None:
            any_for_email = await self.session.execute(
                select(AuthCode).where(AuthCode.email == email)
            )
            all_rows = any_for_email.scalars().all()
            for row in all_rows:
                log.info(
                    "existing code: hash=%s used=%s expires=%s db_now=%s expired=%s",
                    row.code_hash, row.used, row.expires_at, db_now,
                    row.expires_at <= db_now if row.expires_at else "N/A",
                )
            return False
        auth_code.used = True
        return True

    async def store_refresh_token(
        self, user_id: UUID, refresh_token: str, settings: Settings
    ) -> RefreshToken:
        db_now = await self.session.scalar(func.now())
        rt = RefreshToken(
            user_id=user_id,
            token_hash=hash_refresh_token(refresh_token),
            expires_at=db_now
            + timedelta(days=settings.jwt_refresh_expiry_days),
        )
        self.session.add(rt)
        return rt

    async def validate_refresh_token(self, refresh_token: str) -> RefreshToken | None:
        token_h = hash_refresh_token(refresh_token)
        result = await self.session.execute(
            select(RefreshToken).where(
                RefreshToken.token_hash == token_h,
                RefreshToken.revoked == False,
                RefreshToken.expires_at > func.now(),
            )
        )
        return result.scalar_one_or_none()

    async def resolve_api_key(self, raw_key: str) -> UserSchema | None:
        """O(1) lookup by SHA-256 hash. Returns domain Pydantic User."""
        key_h = hash_api_key(raw_key)
        result = await self.session.execute(
            select(UserORM)
            .join(ApiKeyORM, ApiKeyORM.user_id == UserORM.id)
            .where(
                ApiKeyORM.key_hash == key_h,
                ApiKeyORM.revoked == False,
            )
        )
        orm_user = result.scalar_one_or_none()
        return UserSchema.model_validate(orm_user) if orm_user else None

    async def store_api_key(self, user_id: UUID, raw_key: str, label: str) -> ApiKeySchema:
        api_key = ApiKeyORM(
            user_id=user_id,
            key_hash=hash_api_key(raw_key),
            label=label,
        )
        self.session.add(api_key)
        await self.session.flush()
        await self.session.refresh(api_key)
        return ApiKeySchema.model_validate(api_key)

    async def revoke_api_key(self, key_id: UUID, user_id: UUID) -> bool:
        api_key = await self.session.get(ApiKeyORM, key_id)
        if api_key is None or api_key.user_id != user_id:
            return False
        api_key.revoked = True
        return True

    async def list_api_keys(self, user_id: UUID) -> list[ApiKeySchema]:
        """All API keys for a user, newest first. Includes revoked rows
        so the UI can show full history."""
        result = await self.session.execute(
            select(ApiKeyORM)
            .where(ApiKeyORM.user_id == user_id)
            .order_by(ApiKeyORM.created_at.desc())
        )
        return [ApiKeySchema.model_validate(r) for r in result.scalars().all()]
