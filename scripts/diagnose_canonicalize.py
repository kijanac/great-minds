"""Print pairwise similarity diagnostics for canonicalization tuning.

Shows the similarity distribution over all Idea pairs and lists the
most-similar pairs so we can pick a threshold empirically.

Usage:
    uv run python scripts/diagnose_canonicalize.py [--brain-id UUID]
"""

import argparse
import asyncio
import uuid

import numpy as np

from great_minds.core.llm import get_async_client
from great_minds.core.subjects.canonicalizer import (
    _embed_ideas,
    _load_source_cards,
)
from great_minds.core.telemetry import setup_logging

PROTOTYPE_BRAIN_ID = uuid.UUID("11111111-1111-1111-1111-111111111111")


async def run(brain_id: uuid.UUID) -> None:
    cards = _load_source_cards(brain_id)
    ideas = [(card.document_id, idea) for card in cards for idea in card.ideas]
    if not ideas:
        print("No ideas.")
        return

    texts = [f"{idea.label}. {idea.scope_note}" for _, idea in ideas]
    client = get_async_client()
    print(f"Embedding {len(texts)} ideas...")
    V = await _embed_ideas(client, texts)

    sim = V @ V.T
    np.fill_diagonal(sim, -1)
    tri = sim[np.triu_indices_from(sim, k=1)]

    print(f"\nN ideas: {len(ideas)}")
    print(f"N pairs: {len(tri)}\n")

    print("Similarity percentiles:")
    for p in [50, 75, 90, 95, 99, 99.5, 99.9]:
        print(f"  p{p:>5}: {np.percentile(tri, p):.3f}")

    print("\nPairs above thresholds:")
    for t in [0.90, 0.85, 0.80, 0.75, 0.70, 0.65, 0.60, 0.55, 0.50]:
        count = int((tri >= t).sum())
        print(f"  >= {t:.2f}:  {count:>5} pairs")

    print("\nTop 40 most-similar pairs:")
    flat = [
        (i, j, sim[i, j])
        for i in range(len(ideas))
        for j in range(i + 1, len(ideas))
    ]
    flat.sort(key=lambda x: -x[2])
    for i, j, s in flat[:40]:
        _, a = ideas[i]
        _, b = ideas[j]
        same_doc = ideas[i][0] == ideas[j][0]
        mark = "*SAME-DOC*" if same_doc else ""
        print(f"  {s:.3f}  {mark}  [{a.label}]  <->  [{b.label}]")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--brain-id", type=uuid.UUID, default=PROTOTYPE_BRAIN_ID)
    args = parser.parse_args()
    setup_logging(service="great-minds")
    asyncio.run(run(args.brain_id))


if __name__ == "__main__":
    main()
