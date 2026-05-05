"""Storage backend factory.

Picks LocalStorage or R2Storage based on ``settings.storage_backend``.
For the R2 backend the bucket is per-user (provisioned by
``VaultService.create_vault`` and denormalized onto the vault row), so
callers must pass a ``Vault`` — the vault carries its bucket name.
"""

from pathlib import Path

from great_minds.core.vaults.schemas import Vault
from great_minds.core.paths import VAULTS_DIR, vault_dir
from great_minds.core.settings import Settings, get_settings
from great_minds.core.storage import LocalStorage, R2Storage, Storage


def make_storage(vault: Vault, settings: Settings | None = None) -> Storage:
    s = settings or get_settings()
    if s.storage_backend == "r2":
        if not vault.r2_bucket_name:
            raise ValueError(
                f"Vault {vault.id} has no r2_bucket_name; "
                "expected VaultService.create_vault to provision one"
            )
        return R2Storage(
            account_id=s.r2_account_id,
            access_key_id=s.r2_access_key_id,
            secret_access_key=s.r2_secret_access_key,
            bucket=vault.r2_bucket_name,
            prefix=f"{VAULTS_DIR}/{vault.id}",
        )
    return LocalStorage(vault_dir(Path(s.data_dir), vault.id))
