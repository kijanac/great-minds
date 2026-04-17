"""Quantify the convergent-incremental-compilation claims.

Test 1: run the clustering pipeline twice on the same ideas, measure
how stable the cluster structure is across runs.

Test 2: run on a subset of docs vs all docs, measure whether subset
clusters are preserved under full-corpus re-run.

Uses the same ANN-backed clustering as production (cluster_ideas); no
parallel in-memory path.

Usage:
    uv run python scripts/test_convergence.py [--brain-id UUID] [--threshold F]
"""

import argparse
import asyncio
import uuid
from itertools import combinations

from great_minds.core.llm import get_async_client
from great_minds.core.subjects.distiller import (
    _load_source_cards,
    cluster_ideas,
)
from great_minds.core.telemetry import setup_logging

PROTOTYPE_BRAIN_ID = uuid.UUID("11111111-1111-1111-1111-111111111111")


async def run_partition(client, ideas_flat, brain_id, threshold):
    """Run cluster_ideas and return concepts-with-member-sets for comparison."""
    result = await cluster_ideas(
        client,
        brain_id=brain_id,
        ideas_flat=ideas_flat,
        threshold=threshold,
    )
    # Group member idea_ids by their assigned concept
    by_concept: dict[uuid.UUID, set[str]] = {}
    for iid, cid in result.idea_to_concept.items():
        by_concept.setdefault(cid, set()).add(str(iid))
    return [(cid, members) for cid, members in by_concept.items()]


def idea_to_concept_map(concepts_with_members):
    m = {}
    for cid, members in concepts_with_members:
        for mid in members:
            m[mid] = str(cid)
    return m


def partition_metrics(p1, p2, idea_ids):
    m1 = idea_to_concept_map(p1)
    m2 = idea_to_concept_map(p2)
    ids = [i for i in idea_ids if i in m1 and i in m2]
    total = agree = tt = ss = p1_only = p2_only = 0
    for a, b in combinations(ids, 2):
        total += 1
        s1 = m1[a] == m1[b]
        s2 = m2[a] == m2[b]
        if s1 and s2:
            tt += 1
            agree += 1
        elif (not s1) and (not s2):
            ss += 1
            agree += 1
        elif s1 and not s2:
            p1_only += 1
        else:
            p2_only += 1
    return total, agree, tt, ss, p1_only, p2_only


async def test1_rerun(client, brain_id, threshold):
    print("\n" + "=" * 60)
    print("TEST 1: Same-data rerun")
    print("=" * 60)
    cards = _load_source_cards(brain_id)
    ideas_flat = [(card.document_id, idea) for card in cards for idea in card.ideas]
    print(f"Ideas: {len(ideas_flat)}")

    print("Running cluster_ideas (run A)...")
    pA = await run_partition(client, ideas_flat, brain_id, threshold)
    print(f"  Run A:  {len(pA)} concepts")

    print("Running cluster_ideas (run B)...")
    pB = await run_partition(client, ideas_flat, brain_id, threshold)
    print(f"  Run B:  {len(pB)} concepts")

    ids = [str(idea.idea_id) for _, idea in ideas_flat]
    total, agree, tt, ss, only_A, only_B = partition_metrics(pA, pB, ids)
    print(f"\nPair-wise agreement: {agree}/{total} ({100 * agree / total:.2f}%)")
    print(f"  together in both:    {tt}")
    print(f"  separate in both:    {ss}")
    print(f"  together only in A:  {only_A}")
    print(f"  together only in B:  {only_B}")
    if only_A or only_B:
        print("  (non-zero disagreement = LLM refinement producing different polysemy splits)")


async def test2_batch_vs_all(client, brain_id, threshold):
    print("\n" + "=" * 60)
    print("TEST 2: Batch (8 docs) vs all (16 docs)")
    print("=" * 60)
    cards = _load_source_cards(brain_id)
    sorted_cards = sorted(cards, key=lambda c: str(c.document_id))
    first_8 = {str(c.document_id) for c in sorted_cards[:8]}

    all_ideas = [(card.document_id, idea) for card in cards for idea in card.ideas]
    subset_ideas = [(d, idea) for (d, idea) in all_ideas if str(d) in first_8]
    print(f"8-doc ideas:  {len(subset_ideas)}")
    print(f"16-doc ideas: {len(all_ideas)}")

    print("Clustering 8-doc subset...")
    p_8 = await run_partition(client, subset_ideas, brain_id, threshold)
    print(f"  8-doc run:  {len(p_8)} concepts")

    print("Clustering all 16 docs...")
    p_16 = await run_partition(client, all_ideas, brain_id, threshold)
    print(f"  16-doc run: {len(p_16)} concepts")

    subset_ids = [str(idea.idea_id) for _, idea in subset_ideas]
    total, agree, tt, ss, only_8, only_16 = partition_metrics(p_8, p_16, subset_ids)
    print(f"\nAmong the 8-doc ideas, pair-wise agreement: {agree}/{total} ({100 * agree / total:.2f}%)")
    print(f"  together in both:     {tt}  (preserved merges)")
    print(f"  separate in both:     {ss}")
    print(f"  together only 8-doc:  {only_8}  (breakage: previously-merged pairs split in 16-doc)")
    print(f"  together only 16-doc: {only_16}  (emergent merges: new docs bridged them)")
    if only_8 == 0:
        print("  [no breakage — 16-doc run preserves all 8-doc merges]")


async def main(brain_id, threshold):
    client = get_async_client()
    await test1_rerun(client, brain_id, threshold)
    await test2_batch_vs_all(client, brain_id, threshold)


def cli():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--brain-id", type=uuid.UUID, default=PROTOTYPE_BRAIN_ID)
    parser.add_argument("--threshold", type=float, default=0.70)
    args = parser.parse_args()
    setup_logging(service="great-minds")
    asyncio.run(main(args.brain_id, args.threshold))


if __name__ == "__main__":
    cli()
