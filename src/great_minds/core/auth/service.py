"""Auth service: authentication flows, token management, and API keys."""

import logging
import secrets
from uuid import UUID

from great_minds.core.auth.repository import AuthRepository
from great_minds.core.auth.schemas import ApiKey, ApiKeyWithSecret, TokenPair
from great_minds.core.crypto import (
    create_access_token,
    create_refresh_token_value,
    generate_auth_code,
)
from great_minds.core.mail import Mailer, normalize_email
from great_minds.core.settings import Settings
from great_minds.core.users.service import UserService

log = logging.getLogger(__name__)


class AuthService:
    def __init__(
        self,
        auth_repo: AuthRepository,
        user_service: UserService,
        mailer: Mailer,
        settings: Settings,
    ) -> None:
        self.auth_repo = auth_repo
        self.user_service = user_service
        self.mailer = mailer
        self.settings = settings

    async def _commit(self) -> None:
        await self.auth_repo.session.commit()

    async def request_code(self, email: str) -> None:
        """Generate auth code, store it, and email it."""
        email = normalize_email(email)
        if self.settings.suppress_auth:
            log.warning(
                "SUPPRESS_AUTH is active — skipping code generation for %s", email
            )
            return
        code = generate_auth_code()
        await self.auth_repo.store_auth_code(email, code, self.settings)
        # store_auth_code commits internally
        await self.mailer.send(
            to=email,
            subject="Your sign-in code",
            body=f"Your Great Minds sign-in code is: {code}\n\nExpires in {self.settings.auth_code_expiry_minutes} minutes.",
        )

    async def verify_code(self, email: str, code: str) -> TokenPair:
        """Verify auth code, ensure user row exists, mint tokens.

        Returns a ``TokenPair``. The access token carries the user ID
        in its ``sub`` claim for downstream use.
        """
        email = normalize_email(email)
        if self.settings.suppress_auth:
            log.warning(
                "SUPPRESS_AUTH is active — bypassing code verification for %s", email
            )
        else:
            valid = await self.auth_repo.verify_auth_code(email, code)
            if not valid:
                raise ValueError("Invalid or expired code")

        user = await self.user_service.ensure_user(email)

        access_token = create_access_token(user.id, self.settings)
        refresh_token = create_refresh_token_value()
        await self.auth_repo.store_refresh_token(user.id, refresh_token, self.settings)

        await self._commit()
        return TokenPair(access_token=access_token, refresh_token=refresh_token)

    async def refresh_tokens(self, refresh_token: str) -> TokenPair:
        """Validate refresh token, rotate it, return a new TokenPair."""
        rt = await self.auth_repo.validate_refresh_token(refresh_token)
        if rt is None:
            raise ValueError("Invalid or expired refresh token")

        rt.revoked = True
        access_token = create_access_token(rt.user_id, self.settings)
        refresh_token = create_refresh_token_value()
        await self.auth_repo.store_refresh_token(rt.user_id, refresh_token, self.settings)

        await self._commit()
        return TokenPair(access_token=access_token, refresh_token=refresh_token)

    async def create_api_key(self, user_id: UUID, label: str) -> ApiKeyWithSecret:
        """Create an API key, return metadata + the one-time raw secret."""
        raw_key = f"gm_{secrets.token_urlsafe(32)}"
        api_key = await self.auth_repo.store_api_key(user_id, raw_key, label)
        await self._commit()
        return ApiKeyWithSecret(raw_key=raw_key, **api_key.model_dump())

    async def revoke_api_key(self, key_id: UUID, user_id: UUID) -> None:
        """Revoke an API key. Raises ValueError if not found or not owned."""
        revoked = await self.auth_repo.revoke_api_key(key_id, user_id)
        if not revoked:
            raise ValueError("API key not found")
        await self._commit()

    async def list_api_keys(self, user_id: UUID) -> list[ApiKey]:
        return await self.auth_repo.list_api_keys(user_id)
