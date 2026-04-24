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
from great_minds.core.pipeline.cache import ContentHashCache
from great_minds.core.storage import LocalStorage, Storage


@dataclass
class PipelineContext:
    brain_id: UUID
    storage: Storage
    brain_root: Path  # Filesystem path for compile-sidecar I/O (.compile/)
    session: AsyncSession
    client: AsyncOpenAI
    config: BrainConfig
    cache: ContentHashCache


def build_context(
    *,
    brain_id: UUID,
    storage: Storage,
    session: AsyncSession,
    client: AsyncOpenAI,
) -> PipelineContext:
    """Assemble the context a pipeline run needs from its inputs.

    Loads per-brain config from storage and builds a compile-sidecar
    cache rooted at ``<brain_root>/.compile/cache/``. Session and client
    are passed in so the caller controls their lifetimes.

    The compile sidecar uses raw ``Path`` I/O (not the Storage
    abstraction), so we require a ``LocalStorage`` to derive the
    filesystem brain root.
    """
    if not isinstance(storage, LocalStorage):
        raise TypeError(
            "Compile pipeline requires LocalStorage; "
            f"got {type(storage).__name__}"
        )
    return PipelineContext(
        brain_id=brain_id,
        storage=storage,
        brain_root=storage.root,
        session=session,
        client=client,
        config=load_brain_config(storage),
        cache=ContentHashCache.for_brain(storage.root),
    )
