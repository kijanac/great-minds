"""Auth service: authentication flows, token management, and API keys."""

import logging
import secrets
from uuid import UUID

from great_minds.core.auth.models import ApiKey
from great_minds.core.auth.repository import AuthRepository
from great_minds.core.crypto import (
    create_access_token,
    create_refresh_token_value,
    generate_auth_code,
)
from great_minds.core.mail import Mailer
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

    async def request_code(self, email: str) -> None:
        """Generate auth code, store it, and email it."""
        code = generate_auth_code()
        await self.auth_repo.store_auth_code(email, code, self.settings)
        self.mailer.send(
            to=email,
            subject="Your sign-in code",
            body=f"Your Great Minds sign-in code is: {code}\n\nExpires in {self.settings.auth_code_expiry_minutes} minutes.",
        )

    async def verify_code(self, email: str, code: str) -> tuple[str, str]:
        """Verify auth code, provision user if new, return (access_token, refresh_token)."""
        valid = await self.auth_repo.verify_auth_code(email, code)
        if not valid:
            raise ValueError("Invalid or expired code")

        user, _ = await self.user_service.get_or_create(email)
        await self.user_service.ensure_personal_brain(user)

        access_token = create_access_token(user.id, self.settings)
        raw_refresh = create_refresh_token_value()
        await self.auth_repo.store_refresh_token(user.id, raw_refresh, self.settings)

        return access_token, raw_refresh

    async def refresh_tokens(self, raw_refresh: str) -> tuple[str, str]:
        """Validate refresh token, rotate it, return new (access_token, refresh_token)."""
        rt = await self.auth_repo.validate_refresh_token(raw_refresh)
        if rt is None:
            raise ValueError("Invalid or expired refresh token")

        rt.revoked = True
        access_token = create_access_token(rt.user_id, self.settings)
        new_refresh = create_refresh_token_value()
        await self.auth_repo.store_refresh_token(rt.user_id, new_refresh, self.settings)

        return access_token, new_refresh

    async def create_api_key(self, user_id: UUID, label: str) -> tuple[ApiKey, str]:
        """Create an API key, return (api_key_model, raw_key)."""
        raw_key = f"gm_{secrets.token_urlsafe(32)}"
        api_key = await self.auth_repo.store_api_key(user_id, raw_key, label)
        return api_key, raw_key

    async def revoke_api_key(self, key_id: UUID, user_id: UUID) -> None:
        """Revoke an API key. Raises ValueError if not found or not owned."""
        revoked = await self.auth_repo.revoke_api_key(key_id, user_id)
        if not revoked:
            raise ValueError("API key not found")
