from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="")

    database_url: str
    jwt_secret: str
    jwt_access_expiry_minutes: int = 30
    jwt_refresh_expiry_days: int = 7
    auth_code_expiry_minutes: int = 5
    resend_api_key: str | None = None
    resend_from_email: str = "Great Minds <noreply@greatminds.dev>"
    proposals_storage_root: str = "proposals"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
