from typing import Literal

from pydantic import BaseModel, EmailStr

from great_minds.core.auth.schemas import ApiKey, ApiKeyWithSecret


class ApiKeyCreate(BaseModel):
    label: str


class RequestCode(BaseModel):
    email: EmailStr


class VerifyCode(BaseModel):
    email: EmailStr
    code: str


class RefreshRequest(BaseModel):
    refresh_token: str


class AccountDeleteRequest(BaseModel):
    """Self-service delete confirmation. Body must contain ``confirm: "DELETE"``."""

    confirm: Literal["DELETE"]
