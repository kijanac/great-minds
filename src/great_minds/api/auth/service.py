"""Auth service: JWT, hashing, code generation, email sending, user provisioning."""

import hashlib
import logging
import secrets
from datetime import UTC, datetime, timedelta
from uuid import UUID

import jwt
import resend
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.api.auth.models import User
from great_minds.api.brains.repository import create_personal_brain
from great_minds.api.settings import Settings

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# JWT
# ---------------------------------------------------------------------------


def create_access_token(user_id: UUID, settings: Settings) -> str:
    now = datetime.now(UTC)
    payload = {
        "sub": str(user_id),
        "type": "access",
        "iat": now,
        "exp": now + timedelta(minutes=settings.jwt_access_expiry_minutes),
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm="HS256")


def create_refresh_token_value() -> str:
    return secrets.token_urlsafe(48)


def decode_access_token(token: str, settings: Settings) -> UUID:
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=["HS256"])
    except jwt.InvalidTokenError as exc:
        raise ValueError(str(exc))
    if payload.get("type") != "access":
        raise ValueError("Not an access token")
    return UUID(payload["sub"])


# ---------------------------------------------------------------------------
# Hashing
# ---------------------------------------------------------------------------


def hash_code(code: str) -> str:
    return hashlib.sha256(code.encode()).hexdigest()


def hash_refresh_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def hash_api_key(raw_key: str) -> str:
    return hashlib.sha256(raw_key.encode()).hexdigest()


# ---------------------------------------------------------------------------
# Code generation + email
# ---------------------------------------------------------------------------


def generate_auth_code() -> str:
    return f"{secrets.randbelow(1_000_000):06d}"


async def provision_new_user(session: AsyncSession, user: User) -> None:
    """Set up resources for a newly created user (e.g. personal brain)."""
    await create_personal_brain(session, user)


def send_auth_code(email: str, code: str, settings: Settings) -> None:
    if settings.resend_api_key is None:
        log.warning("resend_api_key not set — logging auth code for dev: email=%s code=%s", email, code)
        return

    resend.api_key = settings.resend_api_key
    resend.Emails.send(
        {
            "from": settings.resend_from_email,
            "to": email,
            "subject": "Your sign-in code",
            "text": f"Your Great Minds sign-in code is: {code}\n\nExpires in {settings.auth_code_expiry_minutes} minutes.",
        }
    )
