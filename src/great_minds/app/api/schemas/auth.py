from pydantic import BaseModel, EmailStr

from great_minds.core.auth.schemas import ApiKey


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
