from functools import lru_cache
from typing import Literal

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

    # Storage backend for vault content (raw/, wiki/, config, prompts).
    # "local" writes to data_dir/vaults/<id>/. "r2" provisions one
    # Cloudflare R2 bucket per user (lazily on first vault creation),
    # keyed by ``r2_bucket_prefix-{user_uuid_hex}``; vault content lives
    # under vaults/<id>/ within that bucket. Compile sidecar always
    # stays local under data_dir/.compile/<id>/ regardless.
    storage_backend: Literal["local", "r2"] = "local"
    r2_account_id: str | None = None
    r2_access_key_id: str | None = None
    r2_secret_access_key: str | None = None
    r2_bucket_prefix: str = "gm"

    @model_validator(mode="after")
    def _require_r2_creds(self) -> "Settings":
        if self.storage_backend == "r2":
            missing = [
                name
                for name, value in (
                    ("r2_account_id", self.r2_account_id),
                    ("r2_access_key_id", self.r2_access_key_id),
                    ("r2_secret_access_key", self.r2_secret_access_key),
                )
                if not value
            ]
            if missing:
                raise ValueError(f"storage_backend='r2' requires: {', '.join(missing)}")
        return self

    compile_enrich_concurrency: int = 20
    compile_write_concurrency: int = 3

    compile_partition_target_tokens: int = 100_000
    compile_partition_max_factor: float = 1.5
    compile_partition_min_factor: float = 0.3

    compile_premerge_jaccard_threshold: float = 0.8

    compile_derive_related_limit: int = 20

    log_json: bool = False


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
