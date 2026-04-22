"""OpenRouter client construction and model constants.

Shared across the compile pipeline and querier — single source of
truth for API configuration and client setup.
"""

from openai import AsyncOpenAI, OpenAI

from great_minds.core.settings import get_settings

OPENROUTER_BASE = "https://openrouter.ai/api/v1"

# Model strategy (seven-phase pipeline):
#   - QUERY_MODEL:   fast tool-calling for interactive queries
#   - EXTRACT_MODEL: per-doc extraction; cheap, volume-heavy
#   - MAP_MODEL:     per-chunk thematic synthesis; same model as extract
#   - REDUCE_MODEL:  one call, canonicalizes local themes
#   - RENDER_MODEL:  per-topic article writing
#   - EMBEDDING_MODEL: idea + chunk embeddings
QUERY_MODEL = "deepseek/deepseek-v3.2"
EXTRACT_MODEL = "deepseek/deepseek-v3.2"
MAP_MODEL = "deepseek/deepseek-v3.2"
REDUCE_MODEL = "qwen/qwen3.6-plus"
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
