from functools import lru_cache

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="")

    database_url: str

    @model_validator(mode="after")
    def _normalize_database_url(self) -> "Settings":
        if self.database_url.startswith("postgresql://"):
            self.database_url = self.database_url.replace(
                "postgresql://", "postgresql+asyncpg://", 1
            )
        return self

    jwt_secret: str
    jwt_access_expiry_minutes: int = 30
    jwt_refresh_expiry_days: int = 7
    auth_code_expiry_minutes: int = 10
    openrouter_api_key: str | None = None
    resend_api_key: str | None = None
    resend_from_email: str | None = None
    data_dir: str = "/data"
    cors_origins: list[str] = ["http://localhost:5173"]
    suppress_auth: bool = False

    compile_enrich_concurrency: int = 20
    compile_plan_concurrency: int = 10
    compile_write_concurrency: int = 3


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
