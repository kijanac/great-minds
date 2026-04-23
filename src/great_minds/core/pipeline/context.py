"""PipelineContext bundles everything each phase needs.

Rather than threading (client, session, storage, brain_id, config, ...)
through every phase signature, we pass one context object. Fields are
read-only from the phase's perspective — phases produce Result objects
that flow back through the orchestrator, not by mutating context.
"""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

from openai import AsyncOpenAI
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.core.brain_config import (
    COMPILE_BASE_DIR,
    BrainConfig,
    load_brain_config,
)
from great_minds.core.pipeline.cache import ContentHashCache
from great_minds.core.storage import Storage


@dataclass
class PipelineContext:
    brain_id: UUID
    storage: Storage
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
    base_dir=COMPILE_BASE_DIR,
) -> PipelineContext:
    """Assemble the context a pipeline run needs from its inputs.

    Loads per-brain config from storage, builds a compile-sidecar cache
    rooted at `.compile/<brain_id>/cache/`. Session and client are
    passed in so the caller controls their lifetimes.
    """
    return PipelineContext(
        brain_id=brain_id,
        storage=storage,
        session=session,
        client=client,
        config=load_brain_config(storage),
        cache=ContentHashCache.for_brain(brain_id, base_dir),
    )
