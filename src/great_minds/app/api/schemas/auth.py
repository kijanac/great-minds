import uuid
from datetime import datetime

from pydantic import BaseModel, EmailStr


class UserOverview(BaseModel):
    id: uuid.UUID
    email: str


class User(UserOverview):
    created_at: datetime


class ApiKeyOverview(BaseModel):
    id: uuid.UUID
    label: str
    created_at: datetime


class ApiKey(ApiKeyOverview):
    revoked: bool


class ApiKeyCreate(BaseModel):
    label: str


class ApiKeyCreated(ApiKey):
    """Returned once on creation — includes the raw key, never stored."""

    raw_key: str


class RequestCode(BaseModel):
    email: EmailStr


class VerifyCode(BaseModel):
    email: EmailStr
    code: str


class TokenPair(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"


class RefreshRequest(BaseModel):
    refresh_token: str
