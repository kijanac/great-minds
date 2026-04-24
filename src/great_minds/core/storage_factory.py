"""Storage backend factory.

Picks LocalStorage or R2Storage based on ``settings.storage_backend``.
Callers shouldn't instantiate Storage backends directly — use
``make_storage(brain_id)`` so the deployment's backend choice stays
centralized.
"""

from __future__ import annotations

from pathlib import Path
from uuid import UUID

from great_minds.core.paths import BRAINS_DIR, brain_dir
from great_minds.core.settings import Settings, get_settings
from great_minds.core.storage import LocalStorage, R2Storage, Storage


def make_storage(brain_id: UUID, settings: Settings | None = None) -> Storage:
    s = settings or get_settings()
    if s.storage_backend == "r2":
        return R2Storage(
            account_id=s.r2_account_id,
            access_key_id=s.r2_access_key_id,
            secret_access_key=s.r2_secret_access_key,
            bucket=s.r2_bucket_name,
            prefix=f"{BRAINS_DIR}/{brain_id}",
        )
    return LocalStorage(brain_dir(Path(s.data_dir), brain_id))
