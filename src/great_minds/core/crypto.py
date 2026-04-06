"""Pure cryptographic utilities: hashing, JWT, code generation."""

import hashlib
import secrets
from datetime import UTC, datetime, timedelta
from uuid import UUID

import jwt

from great_minds.core.settings import Settings


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
# Auth codes
# ---------------------------------------------------------------------------


def generate_auth_code() -> str:
    return f"{secrets.randbelow(1_000_000):06d}"
