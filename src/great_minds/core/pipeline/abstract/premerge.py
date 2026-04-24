"""Phase 2c — premerge.

Mechanical exact-match collapse of synthesize's local topics. Union-
find over three signals, applied in order:

  1. Identical slug
  2. Identical (case-insensitive, stripped) title
  3. Jaccard(subsumed_idea_ids) > threshold

All three signals feed the same union-find so chains compose (A ~slug~
B, B ~title~ C → {A, B, C}). No cosine signal — subtler merges are
left to the canonicalize LLM, which has global view and richer
semantics to weigh.

Fully deterministic. Not cached: O(N²) Jaccard is cheap at the scale
where N is "local topics across all chunks" (~600 at 10K-doc scale).
"""

from __future__ import annotations

from collections import defaultdict
from uuid import UUID

from great_minds.core.pipeline.abstract.schemas import LocalTopic
from great_minds.core.telemetry import enrich, log_event


def run(
    local_topics: list[LocalTopic],
    *,
    jaccard_threshold: float,
) -> list[LocalTopic]:
    if not local_topics:
        return []

    # Sort for deterministic representative selection — the first member
    # of a union group (by this key) donates slug/title/description/id.
    ordered = sorted(
        local_topics, key=lambda t: (t.chunk_idx, str(t.local_topic_id))
    )
    n = len(ordered)

    parent = list(range(n))

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: int, b: int) -> bool:
        """Join two components. Returns True iff this call changed state
        (i.e., they were in different components before)."""
        ra, rb = find(a), find(b)
        if ra == rb:
            return False
        # Smaller index wins — deterministic root.
        if ra < rb:
            parent[rb] = ra
        else:
            parent[ra] = rb
        return True

    merges_by_slug = 0
    slug_groups: dict[str, list[int]] = defaultdict(list)
    for i, t in enumerate(ordered):
        if t.slug:
            slug_groups[t.slug].append(i)
    for indices in slug_groups.values():
        for i in indices[1:]:
            if union(indices[0], i):
                merges_by_slug += 1

    merges_by_title = 0
    title_groups: dict[str, list[int]] = defaultdict(list)
    for i, t in enumerate(ordered):
        key = t.title.strip().lower()
        if key:
            title_groups[key].append(i)
    for indices in title_groups.values():
        for i in indices[1:]:
            if union(indices[0], i):
                merges_by_title += 1

    merges_by_jaccard = 0
    idea_sets = [set(t.subsumed_idea_ids) for t in ordered]
    for i in range(n):
        for j in range(i + 1, n):
            if find(i) == find(j):
                continue
            s1, s2 = idea_sets[i], idea_sets[j]
            if not s1 or not s2:
                continue
            union_size = len(s1 | s2)
            if union_size == 0:
                continue
            if (len(s1 & s2) / union_size) > jaccard_threshold:
                if union(i, j):
                    merges_by_jaccard += 1

    groups: dict[int, list[int]] = defaultdict(list)
    for i in range(n):
        groups[find(i)].append(i)

    merged: list[LocalTopic] = []
    for indices in groups.values():
        indices.sort()
        members = [ordered[i] for i in indices]
        rep = members[0]
        all_ideas: set[UUID] = set()
        for m in members:
            all_ideas.update(m.subsumed_idea_ids)
        merged.append(
            LocalTopic(
                local_topic_id=rep.local_topic_id,
                chunk_idx=rep.chunk_idx,
                slug=rep.slug,
                title=rep.title,
                description=rep.description,
                subsumed_idea_ids=sorted(all_ideas, key=str),
            )
        )

    merged.sort(key=lambda t: t.slug)

    enrich(
        premerge_initial=n,
        premerge_final=len(merged),
        premerge_merges_by_slug=merges_by_slug,
        premerge_merges_by_title=merges_by_title,
        premerge_merges_by_jaccard=merges_by_jaccard,
    )
    log_event(
        "pipeline.premerge_completed",
        initial_count=n,
        final_count=len(merged),
        merges_by_slug=merges_by_slug,
        merges_by_title=merges_by_title,
        merges_by_jaccard=merges_by_jaccard,
    )
    return merged
