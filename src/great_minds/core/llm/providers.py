"""OpenRouter client construction and model constants.

Shared across compiler, querier, and linter — single source of truth
for API configuration and client setup.
"""

import os

from openai import AsyncOpenAI, OpenAI

OPENROUTER_BASE = "https://openrouter.ai/api/v1"

# Model strategy:
#   - QUERY_MODEL: fast tool-calling for interactive queries
#   - EXTRACT_MODEL: cheap extraction/planning during compilation
#   - REASON_MODEL: high-quality article writing during compilation
#   - EMBEDDING_MODEL: text embeddings for hybrid search index
QUERY_MODEL = "deepseek/deepseek-v3.2"
EXTRACT_MODEL = "google/gemma-4-31b-it"
REASON_MODEL = "deepseek/deepseek-v3.2"
EMBEDDING_MODEL = "qwen/qwen3-embedding-8b"
EMBEDDING_DIMENSIONS = 1024  # MRL truncation from native 4096

FALLBACK_MODELS = [
    "deepseek/deepseek-v3.2",
    "google/gemma-4-31b-it:free",
]


def get_async_client(*, max_retries: int = 2) -> AsyncOpenAI:
    return AsyncOpenAI(base_url=OPENROUTER_BASE, api_key=os.environ["OPENROUTER_API_KEY"], max_retries=max_retries)


def get_sync_client() -> OpenAI:
    return OpenAI(base_url=OPENROUTER_BASE, api_key=os.environ["OPENROUTER_API_KEY"])
