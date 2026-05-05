"""PipelineContext bundles everything each phase needs.

Rather than threading (client, session, storage, vault_id, config, ...)
through every phase signature, we pass one context object. Fields are
read-only from the phase's perspective — phases produce Result objects
that flow back through the orchestrator, not by mutating context.
"""

from dataclasses import dataclass
from pathlib import Path
from uuid import UUID

from openai import AsyncOpenAI
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.core.vaults.config import VaultConfig, load_vault_config
from great_minds.core.paths import cache_root, sidecar_root
from great_minds.core.pipeline.cache import ContentHashCache
from great_minds.core.settings import get_settings
from great_minds.core.storage import Storage


@dataclass
class PipelineContext:
    vault_id: UUID
    storage: Storage
    sidecar_root: Path  # Machine-local path for compile-sidecar I/O
    session: AsyncSession
    client: AsyncOpenAI
    config: VaultConfig
    cache: ContentHashCache


async def build_context(
    *,
    vault_id: UUID,
    storage: Storage,
    session: AsyncSession,
    client: AsyncOpenAI,
) -> PipelineContext:
    """Assemble the context a pipeline run needs from its inputs.

    Loads per-vault config from storage and builds a compile-sidecar
    cache rooted at ``<data_dir>/.compile/<vault_id>/cache/`` — always
    local, regardless of the Storage backend. Session and client are
    passed in so the caller controls their lifetimes.
    """
    sidecar = sidecar_root(Path(get_settings().data_dir), vault_id)
    return PipelineContext(
        vault_id=vault_id,
        storage=storage,
        sidecar_root=sidecar,
        session=session,
        client=client,
        config=await load_vault_config(storage),
        cache=ContentHashCache(cache_root(sidecar)),
    )
