"""Embedding utilities: batch embedding via OpenRouter with MRL truncation."""

import asyncio

import numpy as np
from openai import AsyncOpenAI

from great_minds.core.llm.providers import EMBEDDING_DIMENSIONS, EMBEDDING_MODEL

MAX_EMBED_RETRIES = 3


def truncate_and_normalize(embedding: list[float], dims: int) -> list[float]:
    """MRL truncation to target dims, then L2 normalize via numpy."""
    arr = np.asarray(embedding)[:dims]
    norm = np.linalg.norm(arr)
    if norm == 0:
        return arr.tolist()
    return (arr / norm).tolist()


async def embed_batch(client: AsyncOpenAI, texts: list[str]) -> list[list[float]]:
    """Embed a batch of texts via OpenRouter with retries + MRL truncation."""
    for attempt in range(1, MAX_EMBED_RETRIES + 1):
        try:
            response = await client.embeddings.create(
                model=EMBEDDING_MODEL, input=texts
            )
            return [
                truncate_and_normalize(item.embedding, EMBEDDING_DIMENSIONS)
                for item in response.data
            ]
        except Exception:
            if attempt == MAX_EMBED_RETRIES:
                raise
            await asyncio.sleep(2**attempt)
    raise AssertionError("embed_batch loop exited without resolution")
