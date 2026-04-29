"""PipelineContext bundles everything each phase needs.

Rather than threading (client, session, storage, brain_id, config, ...)
through every phase signature, we pass one context object. Fields are
read-only from the phase's perspective — phases produce Result objects
that flow back through the orchestrator, not by mutating context.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from uuid import UUID

from openai import AsyncOpenAI
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.core.brain_config import BrainConfig, load_brain_config
from great_minds.core.paths import cache_root, sidecar_root
from great_minds.core.pipeline.cache import ContentHashCache
from great_minds.core.settings import get_settings
from great_minds.core.storage import Storage


@dataclass
class PipelineContext:
    brain_id: UUID
    storage: Storage
    sidecar_root: Path  # Machine-local path for compile-sidecar I/O
    session: AsyncSession
    client: AsyncOpenAI
    config: BrainConfig
    cache: ContentHashCache


async def build_context(
    *,
    brain_id: UUID,
    storage: Storage,
    session: AsyncSession,
    client: AsyncOpenAI,
) -> PipelineContext:
    """Assemble the context a pipeline run needs from its inputs.

    Loads per-brain config from storage and builds a compile-sidecar
    cache rooted at ``<data_dir>/.compile/<brain_id>/cache/`` — always
    local, regardless of the Storage backend. Session and client are
    passed in so the caller controls their lifetimes.
    """
    sidecar = sidecar_root(Path(get_settings().data_dir), brain_id)
    return PipelineContext(
        brain_id=brain_id,
        storage=storage,
        sidecar_root=sidecar,
        session=session,
        client=client,
        config=await load_brain_config(storage),
        cache=ContentHashCache(cache_root(sidecar)),
    )
