"""OpenRouter client construction and model constants.

Shared across the compile pipeline and querier — single source of
truth for API configuration and client setup.
"""

from openai import AsyncOpenAI, OpenAI

from great_minds.core.settings import get_settings

OPENROUTER_BASE = "https://openrouter.ai/api/v1"

# Model strategy (seven-phase pipeline):
#   - QUERY_MODEL:   tool-calling agent for interactive queries
#   - EXTRACT_MODEL: per-doc extraction; cheap, volume-heavy
#   - MAP_MODEL:     per-chunk thematic synthesis; same model as extract
#   - REDUCE_MODEL:  one call, canonicalizes local themes
#   - RENDER_MODEL:  per-topic article writing
#   - EMBEDDING_MODEL: idea + chunk embeddings
# QUERY_MODEL: chosen by A/B over the corpus — vs deepseek-v3.2/v4 it grounds
# harder, discloses gaps, and emits anchored citations. glm-5.2 keeps that
# discipline at ~the same price but adds a 1M context window (vs 5.1's ~203k),
# which removes the over-retrieval context-overflow failure mode. Clients can
# override per request (e.g. anthropic/claude-sonnet-4.6 for high-stakes asks,
# ~5x the per-query cost).
QUERY_MODEL = "z-ai/glm-5.2"
EXTRACT_MODEL = "deepseek/deepseek-v3.2"
MAP_MODEL = "deepseek/deepseek-v3.2"
# REDUCE_MODEL: the one-shot canonical carve over hundreds of local themes is the
# pipeline's hardest single generation — a weaker model over-merges (collapses the
# table of contents to a few mega-articles) and draws a different partition each
# run, which churns the wiki. A strong model carves a stable, properly-grained
# article set. The extra cost lands only on this phase (one registry call + the
# assign batches per compile).
REDUCE_MODEL = "anthropic/claude-sonnet-4.6"
RENDER_MODEL = "qwen/qwen3.6-plus"
EMBEDDING_MODEL = "qwen/qwen3-embedding-8b"
EMBEDDING_DIMENSIONS = 1024  # MRL truncation from native 4096

FALLBACK_MODELS = [
    "deepseek/deepseek-v3.2",
]


def _api_key() -> str:
    key = get_settings().openrouter_api_key
    if not key:
        raise RuntimeError("OPENROUTER_API_KEY is not configured")
    return key


def get_async_client(*, max_retries: int = 2, timeout: float = 120.0) -> AsyncOpenAI:
    return AsyncOpenAI(
        base_url=OPENROUTER_BASE,
        api_key=_api_key(),
        max_retries=max_retries,
        timeout=timeout,
    )


def get_sync_client() -> OpenAI:
    return OpenAI(base_url=OPENROUTER_BASE, api_key=_api_key())
