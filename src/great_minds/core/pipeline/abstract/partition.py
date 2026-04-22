"""Phase 2a — partition.

Mechanical step: seeded k-means over all idea embeddings with a token-
budget-driven k. Output is a list of chunks, each a list of idea_ids,
consumed by 2b synthesize. Fully deterministic for a given embedding
set + target token budget (sklearn KMeans with fixed random_state,
deterministic rebalance tie-breaking).

Token estimation matches how ideas are rendered for 2b's prompt:
per-idea line + doc header + precis. Approximation uses chars/4 for
speed — exact tokenization isn't needed for cluster-count rounding.
"""

from __future__ import annotations

import hashlib
import logging
import math
from dataclasses import dataclass, field
from uuid import UUID

import numpy as np
from sklearn.cluster import KMeans

from great_minds.core.ideas.repository import IdeaEmbeddingRepository
from great_minds.core.ideas.schemas import Idea, SourceCard
from great_minds.core.pipeline.context import PipelineContext
from great_minds.core.settings import get_settings
from great_minds.core.telemetry import enrich, log_event

log = logging.getLogger(__name__)

PHASE = "partition"
KMEANS_SEED = 42
KMEANS_N_INIT = 10


@dataclass
class PartitionResult:
    chunks: list[list[UUID]] = field(default_factory=list)
    cache_hit: bool = False
    k_initial: int = 0
    k_final: int = 0
    total_tokens: int = 0


async def run(
    ctx: PipelineContext, source_cards: list[SourceCard]
) -> PartitionResult:
    settings = get_settings()
    target = settings.compile_partition_target_tokens
    max_tokens = int(target * settings.compile_partition_max_factor)
    min_tokens = int(target * settings.compile_partition_min_factor)

    idea_index = _index_ideas(source_cards)

    repo = IdeaEmbeddingRepository(ctx.session)
    embeddings = await repo.load_embeddings(ctx.brain_id)
    id_order = sorted(e[0] for e in embeddings)  # deterministic order

    if not id_order:
        log_event(
            "pipeline.partition_skipped",
            brain_id=str(ctx.brain_id),
            reason="no_embeddings",
        )
        return PartitionResult()

    cache_key = _cache_key(id_order, target)
    cached = ctx.cache.get(PHASE, cache_key)
    if cached is not None:
        chunks = [[UUID(x) for x in c] for c in cached["chunks"]]
        enrich(
            partition_cache_hit=True,
            partition_chunk_count=len(chunks),
        )
        log_event(
            "pipeline.partition_cached",
            brain_id=str(ctx.brain_id),
            chunk_count=len(chunks),
        )
        return PartitionResult(
            chunks=chunks,
            cache_hit=True,
            k_initial=cached.get("k_initial", len(chunks)),
            k_final=len(chunks),
            total_tokens=cached.get("total_tokens", 0),
        )

    tokens_per_idea = {
        iid: _estimate_idea_tokens(idea_index[iid])
        for iid in id_order
        if iid in idea_index
    }
    # Ideas with no matching source_card (shouldn't happen post-extract,
    # but be robust) get a conservative default.
    for iid in id_order:
        if iid not in tokens_per_idea:
            tokens_per_idea[iid] = 100
    total_tokens = sum(tokens_per_idea.values())

    k = max(1, math.ceil(total_tokens / target))
    k = min(k, len(id_order))

    labels = _seeded_kmeans(embeddings, id_order, k)

    chunks = _group_by_label(id_order, labels)
    chunks = _rebalance(
        chunks=chunks,
        tokens_per_idea=tokens_per_idea,
        embeddings=dict(embeddings),
        max_tokens=max_tokens,
        min_tokens=min_tokens,
    )

    ctx.cache.put(
        PHASE,
        cache_key,
        {
            "chunks": [[str(u) for u in c] for c in chunks],
            "k_initial": k,
            "total_tokens": total_tokens,
        },
    )

    enrich(
        partition_cache_hit=False,
        partition_k_initial=k,
        partition_chunk_count=len(chunks),
        partition_total_tokens=total_tokens,
    )
    log_event(
        "pipeline.partition_completed",
        brain_id=str(ctx.brain_id),
        k_initial=k,
        chunk_count=len(chunks),
        total_tokens=total_tokens,
    )
    return PartitionResult(
        chunks=chunks,
        cache_hit=False,
        k_initial=k,
        k_final=len(chunks),
        total_tokens=total_tokens,
    )


# ---------------------------------------------------------------------------
# Token estimation
# ---------------------------------------------------------------------------


def _index_ideas(cards: list[SourceCard]) -> dict[UUID, tuple[Idea, SourceCard]]:
    out: dict[UUID, tuple[Idea, SourceCard]] = {}
    for card in cards:
        for idea in card.ideas:
            out[idea.idea_id] = (idea, card)
    return out


def _estimate_idea_tokens(item: tuple[Idea, SourceCard]) -> int:
    """Approximate tokens for one idea rendered with doc provenance.

    Matches 2b's rendering shape:
      [kind] label: description
      ← from {title} ({genre}, ...) interlocutors: ... tags: ...
      ← precis: ...

    chars/4 is a rough tokenization heuristic — good enough for rounding
    k to an integer, not exact.
    """
    idea, card = item
    idea_line = f"[{idea.kind}] {idea.label}: {idea.description}"
    meta = card.doc_metadata
    doc_header = (
        f"from {card.title} ({meta.genre or ''}); "
        f"tradition: {meta.tradition or ''}; "
        f"interlocutors: {','.join(meta.interlocutors)}; "
        f"tags: {','.join(meta.tags)}"
    )
    precis_line = f"precis: {card.precis}"
    chars = len(idea_line) + len(doc_header) + len(precis_line)
    return max(1, chars // 4)


# ---------------------------------------------------------------------------
# k-means + rebalance
# ---------------------------------------------------------------------------


def _seeded_kmeans(
    embeddings: list[tuple[UUID, list[float]]],
    id_order: list[UUID],
    k: int,
) -> dict[UUID, int]:
    if k == 1:
        return {iid: 0 for iid in id_order}

    lookup = dict(embeddings)
    matrix = np.array([lookup[iid] for iid in id_order], dtype=np.float32)
    km = KMeans(n_clusters=k, random_state=KMEANS_SEED, n_init=KMEANS_N_INIT)
    labels = km.fit_predict(matrix)
    return {iid: int(lab) for iid, lab in zip(id_order, labels)}


def _group_by_label(
    id_order: list[UUID], labels: dict[UUID, int]
) -> list[list[UUID]]:
    grouped: dict[int, list[UUID]] = {}
    for iid in id_order:
        grouped.setdefault(labels[iid], []).append(iid)
    # Sort by label for determinism; idea_ids within a chunk already
    # sorted by their position in id_order.
    return [grouped[k] for k in sorted(grouped)]


def _rebalance(
    *,
    chunks: list[list[UUID]],
    tokens_per_idea: dict[UUID, int],
    embeddings: dict[UUID, list[float]],
    max_tokens: int,
    min_tokens: int,
) -> list[list[UUID]]:
    """Split oversize chunks by sub-k-means; merge undersize chunks into
    nearest centroid. Deterministic: ties broken by sorted idea_id.
    """
    chunks = _split_oversize(chunks, tokens_per_idea, embeddings, max_tokens)
    chunks = _merge_undersize(chunks, tokens_per_idea, embeddings, min_tokens, max_tokens)
    return chunks


def _chunk_tokens(chunk: list[UUID], tokens_per_idea: dict[UUID, int]) -> int:
    return sum(tokens_per_idea[i] for i in chunk)


def _split_oversize(
    chunks: list[list[UUID]],
    tokens_per_idea: dict[UUID, int],
    embeddings: dict[UUID, list[float]],
    max_tokens: int,
) -> list[list[UUID]]:
    out: list[list[UUID]] = []
    for chunk in chunks:
        if _chunk_tokens(chunk, tokens_per_idea) <= max_tokens or len(chunk) < 2:
            out.append(chunk)
            continue
        out.extend(_split_recursively(chunk, tokens_per_idea, embeddings, max_tokens))
    return out


def _split_recursively(
    chunk: list[UUID],
    tokens_per_idea: dict[UUID, int],
    embeddings: dict[UUID, list[float]],
    max_tokens: int,
) -> list[list[UUID]]:
    if _chunk_tokens(chunk, tokens_per_idea) <= max_tokens or len(chunk) < 2:
        return [chunk]
    ordered = sorted(chunk)
    matrix = np.array([embeddings[i] for i in ordered], dtype=np.float32)
    km = KMeans(n_clusters=2, random_state=KMEANS_SEED, n_init=KMEANS_N_INIT)
    labels = km.fit_predict(matrix)
    part_a = [i for i, lab in zip(ordered, labels) if lab == 0]
    part_b = [i for i, lab in zip(ordered, labels) if lab == 1]
    # Degenerate: all ideas collapsed to one label. Split by halves
    # as a deterministic fallback so recursion terminates.
    if not part_a or not part_b:
        mid = len(ordered) // 2
        part_a, part_b = ordered[:mid], ordered[mid:]
    return _split_recursively(part_a, tokens_per_idea, embeddings, max_tokens) + (
        _split_recursively(part_b, tokens_per_idea, embeddings, max_tokens)
    )


def _merge_undersize(
    chunks: list[list[UUID]],
    tokens_per_idea: dict[UUID, int],
    embeddings: dict[UUID, list[float]],
    min_tokens: int,
    max_tokens: int,
) -> list[list[UUID]]:
    if len(chunks) <= 1:
        return chunks

    centroids = [_centroid(c, embeddings) for c in chunks]
    sizes = [_chunk_tokens(c, tokens_per_idea) for c in chunks]

    while True:
        under_indices = [i for i, s in enumerate(sizes) if s < min_tokens]
        if not under_indices:
            break
        # Deterministic pick: smallest chunk first, ties by first idea_id
        under_indices.sort(key=lambda i: (sizes[i], sorted(chunks[i])[0]))
        src = under_indices[0]

        nearest, nearest_dist = None, float("inf")
        for j in range(len(chunks)):
            if j == src:
                continue
            if sizes[src] + sizes[j] > max_tokens:
                continue
            dist = _cosine_distance(centroids[src], centroids[j])
            if dist < nearest_dist:
                nearest_dist = dist
                nearest = j
        if nearest is None:
            # Can't merge without blowing max_tokens — leave as-is.
            break

        merged = sorted(chunks[src] + chunks[nearest])
        merged_centroid = _centroid(merged, embeddings)
        merged_size = sizes[src] + sizes[nearest]

        # Remove the two merged chunks, insert the result (rebuild lists
        # to avoid fiddly index bookkeeping).
        to_drop = {src, nearest}
        chunks = [c for i, c in enumerate(chunks) if i not in to_drop] + [merged]
        centroids = [c for i, c in enumerate(centroids) if i not in to_drop] + [
            merged_centroid
        ]
        sizes = [s for i, s in enumerate(sizes) if i not in to_drop] + [merged_size]

    return chunks


def _centroid(chunk: list[UUID], embeddings: dict[UUID, list[float]]) -> np.ndarray:
    vecs = np.array([embeddings[i] for i in chunk], dtype=np.float32)
    return vecs.mean(axis=0)


def _cosine_distance(a: np.ndarray, b: np.ndarray) -> float:
    denom = (np.linalg.norm(a) * np.linalg.norm(b)) or 1.0
    return float(1.0 - np.dot(a, b) / denom)


# ---------------------------------------------------------------------------
# Cache key
# ---------------------------------------------------------------------------


def _cache_key(id_order: list[UUID], target_tokens: int) -> str:
    h = hashlib.sha256()
    for iid in id_order:
        h.update(str(iid).encode())
        h.update(b":")
    h.update(f"target={target_tokens}".encode())
    return h.hexdigest()
