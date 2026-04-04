"""OpenRouter client construction and model constants.

Shared across compiler, querier, and linter — single source of truth
for API configuration and client setup.
"""

import os

from openai import AsyncOpenAI, OpenAI

OPENROUTER_BASE = "https://openrouter.ai/api/v1"

# Two-model strategy: cheap for extraction/planning, expensive for writing
EXTRACT_MODEL = "google/gemma-4-31b-it"
REASON_MODEL = "deepseek/deepseek-v3.2"

FALLBACK_MODELS = [
    "deepseek/deepseek-v3.2",
    "google/gemma-4-31b-it:free",
]


def _get_api_key() -> str:
    api_key = os.environ.get("OPENROUTER_API_KEY")
    if not api_key:
        raise RuntimeError(
            "Set OPENROUTER_API_KEY environment variable. "
            "Get one at https://openrouter.ai/keys"
        )
    return api_key


def get_async_client() -> AsyncOpenAI:
    return AsyncOpenAI(base_url=OPENROUTER_BASE, api_key=_get_api_key())


def get_sync_client() -> OpenAI:
    return OpenAI(base_url=OPENROUTER_BASE, api_key=_get_api_key())
