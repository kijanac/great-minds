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

import logging
import math
from uuid import UUID

import numpy as np
from sklearn.cluster import KMeans

from great_minds.core.hashing import content_hash
from great_minds.core.compile_cache import CompileCacheRepository
from great_minds.core.ideas.service import IdeaService
from great_minds.core.ideas.schemas import Idea, SourceCard
from great_minds.core.telemetry import enrich, log_event

log = logging.getLogger(__name__)

PHASE = "partition"
KMEANS_SEED = 42
KMEANS_N_INIT = 10


class PartitionPhase:
    """Phase 2a runner with explicit service-style dependencies."""

    def __init__(
        self,
        *,
        ideas: IdeaService,
        compile_cache: CompileCacheRepository,
        target_tokens: int,
        min_factor: float,
        max_factor: float,
    ) -> None:
        self.ideas = ideas
        self.compile_cache = compile_cache
        self.target_tokens = target_tokens
        self.min_factor = min_factor
        self.max_factor = max_factor

    async def run(self, vault_id: UUID) -> list[list[UUID]]:
        target = self.target_tokens
        max_tokens = int(target * self.max_factor)
        min_tokens = int(target * self.min_factor)

        idea_overviews = await self.ideas.list_for_vault(vault_id)
        id_order = [o.idea_id for o in idea_overviews]

        if not id_order:
            log_event(
                "skipped",
                reason="no_embeddings",
            )
            return []

        cache_key = _cache_key(id_order, target)
        cached = await self.compile_cache.get(
            vault_id=vault_id,
            phase=PHASE,
            cache_key=cache_key,
        )
        if cached is not None:
            chunks = [[UUID(x) for x in c] for c in cached["chunks"]]
            enrich(
                partition_cache_hit=True,
                partition_chunk_count=len(chunks),
            )
            log_event(
                "cached",
                chunk_count=len(chunks),
            )
            return chunks

        tokens_by_id = await _estimate_tokens_by_id(self.ideas, vault_id, id_order)
        tokens_by_row = [tokens_by_id.get(iid, 100) for iid in id_order]
        total_tokens = sum(tokens_by_row)

        k = max(1, math.ceil(total_tokens / target))
        k = min(k, len(id_order))

        embedding_matrix = np.asarray(
            [o.embedding for o in idea_overviews], dtype=np.float32
        )
        del idea_overviews

        labels = _seeded_kmeans(embedding_matrix, k)

        chunks = _group_by_label(labels)
        chunks = _rebalance(
            chunks=chunks,
            tokens_by_row=tokens_by_row,
            embedding_matrix=embedding_matrix,
            max_tokens=max_tokens,
            min_tokens=min_tokens,
        )
        chunks_by_id = [[id_order[row] for row in chunk] for chunk in chunks]

        await self.compile_cache.put(
            vault_id=vault_id,
            phase=PHASE,
            cache_key=cache_key,
            value={
                "chunks": [[str(u) for u in c] for c in chunks_by_id],
                "k_initial": k,
                "total_tokens": total_tokens,
            },
        )

        enrich(
            partition_cache_hit=False,
            partition_k_initial=k,
            partition_chunk_count=len(chunks_by_id),
            partition_total_tokens=total_tokens,
        )
        log_event(
            "completed",
            k_initial=k,
            chunk_count=len(chunks_by_id),
            total_tokens=total_tokens,
        )
        return chunks_by_id


# ---------------------------------------------------------------------------
# Token estimation
# ---------------------------------------------------------------------------


async def _estimate_tokens_by_id(
    ideas: IdeaService,
    vault_id: UUID,
    idea_ids: list[UUID],
) -> dict[UUID, int]:
    """Approximate token counts for requested ideas via a streaming scan."""
    wanted = set(idea_ids)
    out: dict[UUID, int] = {}
    if not wanted:
        return out
    async for card in ideas.iter_source_cards(vault_id):
        for idea in card.ideas:
            if idea.idea_id not in wanted:
                continue
            out[idea.idea_id] = _estimate_idea_tokens(idea, card)
            wanted.discard(idea.idea_id)
        if not wanted:
            break
    return out


def _estimate_idea_tokens(idea: Idea, card: SourceCard) -> int:
    """Approximate tokens for one idea rendered with doc provenance.

    Matches 2b's rendering shape:
      [kind] label: description
      ← from {title} ({genre}); tags: ...
      ← precis: ...

    chars/4 is a rough tokenization heuristic — good enough for rounding
    k to an integer, not exact. Must stay in sync with what synthesize
    actually puts in the prompt — if synthesize starts rendering
    additional fields, this estimate has to follow.
    """
    idea_line = f"[{idea.kind}] {idea.label}: {idea.description}"
    title_part = f"from {card.title}"
    if card.genre:
        title_part += f" ({card.genre})"
    doc_header = f"{title_part}; tags: {','.join(card.tags)}"
    precis_line = f"precis: {card.precis}"
    chars = len(idea_line) + len(doc_header) + len(precis_line)
    return max(1, chars // 4)


# ---------------------------------------------------------------------------
# k-means + rebalance
# ---------------------------------------------------------------------------


def _seeded_kmeans(embedding_matrix: np.ndarray, k: int) -> list[int]:
    if k == 1:
        return [0] * len(embedding_matrix)

    km = KMeans(n_clusters=k, random_state=KMEANS_SEED, n_init=KMEANS_N_INIT)
    return [int(lab) for lab in km.fit_predict(embedding_matrix)]


def _group_by_label(labels: list[int]) -> list[list[int]]:
    grouped: dict[int, list[int]] = {}
    for row, label in enumerate(labels):
        grouped.setdefault(label, []).append(row)
    # Sort by label for determinism; row indices already follow id_order.
    return [grouped[k] for k in sorted(grouped)]


def _rebalance(
    *,
    chunks: list[list[int]],
    tokens_by_row: list[int],
    embedding_matrix: np.ndarray,
    max_tokens: int,
    min_tokens: int,
) -> list[list[int]]:
    """Split oversize chunks by sub-k-means; merge undersize chunks into
    nearest centroid. Deterministic: ties broken by sorted idea_id.
    """
    chunks = [
        split
        for chunk in chunks
        for split in _split_recursively(
            chunk, tokens_by_row, embedding_matrix, max_tokens
        )
    ]
    chunks = _merge_undersize(
        chunks, tokens_by_row, embedding_matrix, min_tokens, max_tokens
    )
    return chunks


def _chunk_tokens(chunk: list[int], tokens_by_row: list[int]) -> int:
    return sum(tokens_by_row[row] for row in chunk)


def _split_recursively(
    chunk: list[int],
    tokens_by_row: list[int],
    embedding_matrix: np.ndarray,
    max_tokens: int,
) -> list[list[int]]:
    if _chunk_tokens(chunk, tokens_by_row) <= max_tokens or len(chunk) < 2:
        return [chunk]
    ordered = sorted(chunk)
    matrix = embedding_matrix[ordered]
    km = KMeans(n_clusters=2, random_state=KMEANS_SEED, n_init=KMEANS_N_INIT)
    labels = km.fit_predict(matrix)
    part_a = [i for i, lab in zip(ordered, labels) if lab == 0]
    part_b = [i for i, lab in zip(ordered, labels) if lab == 1]
    # Degenerate: all ideas collapsed to one label. Split by halves
    # as a deterministic fallback so recursion terminates.
    if not part_a or not part_b:
        mid = len(ordered) // 2
        part_a, part_b = ordered[:mid], ordered[mid:]
    return _split_recursively(part_a, tokens_by_row, embedding_matrix, max_tokens) + (
        _split_recursively(part_b, tokens_by_row, embedding_matrix, max_tokens)
    )


def _merge_undersize(
    chunks: list[list[int]],
    tokens_by_row: list[int],
    embedding_matrix: np.ndarray,
    min_tokens: int,
    max_tokens: int,
) -> list[list[int]]:
    if len(chunks) <= 1:
        return chunks

    centroids = np.asarray(
        [embedding_matrix[c].mean(axis=0) for c in chunks], dtype=np.float32
    )
    normalized_centroids = _normalize_rows(centroids)
    sizes = [_chunk_tokens(c, tokens_by_row) for c in chunks]

    while True:
        under_indices = [i for i, s in enumerate(sizes) if s < min_tokens]
        if not under_indices:
            break
        # Deterministic pick: smallest chunk first, ties by first idea_id
        under_indices.sort(key=lambda i: (sizes[i], sorted(chunks[i])[0]))
        src = under_indices[0]

        valid = np.asarray(
            [
                i != src and sizes[src] + size <= max_tokens
                for i, size in enumerate(sizes)
            ]
        )
        if not valid.any():
            # Can't merge without blowing max_tokens — leave as-is.
            break
        similarities = normalized_centroids @ normalized_centroids[src]
        distances = 1.0 - similarities
        distances[~valid] = np.inf
        nearest = int(np.argmin(distances))
        if not np.isfinite(distances[nearest]):
            # Can't merge without blowing max_tokens — leave as-is.
            break

        merged = sorted(chunks[src] + chunks[nearest])
        merged_centroid = embedding_matrix[merged].mean(axis=0)
        merged_size = sizes[src] + sizes[nearest]

        # Remove the two merged chunks, insert the result (rebuild lists
        # to avoid fiddly index bookkeeping).
        to_drop = {src, nearest}
        chunks = [c for i, c in enumerate(chunks) if i not in to_drop] + [merged]
        centroids = np.asarray(
            [c for i, c in enumerate(centroids) if i not in to_drop]
            + [merged_centroid],
            dtype=np.float32,
        )
        normalized_centroids = _normalize_rows(centroids)
        sizes = [s for i, s in enumerate(sizes) if i not in to_drop] + [merged_size]

    return chunks


def _normalize_rows(matrix: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    out = np.zeros_like(matrix)
    np.divide(matrix, norms, out=out, where=norms != 0)
    return out


# ---------------------------------------------------------------------------
# Cache key
# ---------------------------------------------------------------------------


def _cache_key(id_order: list[UUID], target_tokens: int) -> str:
    return content_hash(
        *sorted(str(iid) for iid in id_order),
        f"target={target_tokens}",
    )
