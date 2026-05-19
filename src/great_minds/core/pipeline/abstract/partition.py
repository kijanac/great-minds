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
from collections.abc import Awaitable, Callable
from uuid import UUID

import numpy as np
from sklearn.cluster import KMeans, MiniBatchKMeans

from great_minds.core.hashing import content_hash
from great_minds.core.compile_cache import CompileCacheRepository
from great_minds.core.ideas.service import IdeaService
from great_minds.core.ideas.schemas import Idea, SourceCard
from great_minds.core.llm.providers import EMBEDDING_DIMENSIONS
from great_minds.core.telemetry import enrich, log_event

log = logging.getLogger(__name__)

PHASE = "partition"
KMEANS_SEED = 42
# MiniBatch params for the corpus-wide cluster. batch_size is sklearn's
# default; max_epochs caps the work while convergence-shift early-stops
# in practice. Tune these together if cluster quality drifts.
KMEANS_BATCH_SIZE = 1024
KMEANS_MAX_EPOCHS = 10
KMEANS_TOL = 1e-3

ProgressCallback = Callable[[int, int], Awaitable[None]]


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
        report_progress: ProgressCallback | None = None,
    ) -> None:
        self.ideas = ideas
        self.compile_cache = compile_cache
        self.target_tokens = target_tokens
        self.min_factor = min_factor
        self.max_factor = max_factor
        self.report_progress = report_progress

    async def run(self, vault_id: UUID) -> list[list[UUID]]:
        target = self.target_tokens
        max_tokens = int(target * self.max_factor)
        min_tokens = int(target * self.min_factor)

        # IDs first — cheap, narrow read; cache hit returns without ever
        # loading the 43k+ vector embeddings into memory.
        id_order = sorted(await self.ideas.get_ids_for_vault(vault_id))

        if not id_order:
            log_event("skipped", reason="no_embeddings")
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
            log_event("cached", chunk_count=len(chunks))
            return chunks

        tokens_by_id = await _estimate_tokens_by_id(self.ideas, vault_id, id_order)
        tokens_by_row = np.asarray(
            [tokens_by_id.get(iid, 100) for iid in id_order], dtype=np.int64
        )
        total_tokens = int(tokens_by_row.sum())

        k = max(1, math.ceil(total_tokens / target))
        k = min(k, len(id_order))

        # Stream embeddings into a pre-allocated matrix to avoid the 2×
        # transient that np.asarray([list]) creates at OOM-risky scale.
        # iter_overviews and sorted(id_order) share idea_id ordering, so
        # positional fill aligns.
        n = len(id_order)
        embedding_matrix = np.empty((n, EMBEDDING_DIMENSIONS), dtype=np.float32)
        row = 0
        async for batch in self.ideas.iter_overviews(
            vault_id, batch_size=KMEANS_BATCH_SIZE
        ):
            for overview in batch:
                embedding_matrix[row] = overview.embedding
                row += 1

        labels = await _seeded_kmeans(
            embedding_matrix, k, report_progress=self.report_progress
        )

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


async def _seeded_kmeans(
    embedding_matrix: np.ndarray,
    k: int,
    *,
    report_progress: ProgressCallback | None = None,
) -> np.ndarray:
    """Cluster ``embedding_matrix`` into ``k`` groups via MiniBatchKMeans.

    Manual partial_fit loop so we can emit per-epoch progress to the
    pipeline UI. With ``n_init=1`` and k-means++ init the single run is
    almost always within a couple percent of inertia-optimal — full
    multi-init wasn't paying for itself at the scale this runs at.

    Early-stops when centroid shift between epochs falls below
    ``KMEANS_TOL``; the final progress emit always reports
    ``(max_epochs, max_epochs)`` so the UI doesn't show a partial bar
    when we converged ahead of schedule.
    """
    n = embedding_matrix.shape[0]
    if k == 1:
        if report_progress is not None:
            await report_progress(KMEANS_MAX_EPOCHS, KMEANS_MAX_EPOCHS)
        return np.zeros(n, dtype=np.int64)

    mbkm = MiniBatchKMeans(
        n_clusters=k,
        random_state=KMEANS_SEED,
        n_init=1,
        batch_size=KMEANS_BATCH_SIZE,
    )
    rng = np.random.default_rng(KMEANS_SEED)
    prev_centers: np.ndarray | None = None
    epochs_run = 0

    if report_progress is not None:
        await report_progress(0, KMEANS_MAX_EPOCHS)

    for epoch in range(KMEANS_MAX_EPOCHS):
        order = rng.permutation(n)
        for start in range(0, n, KMEANS_BATCH_SIZE):
            batch_idx = order[start : start + KMEANS_BATCH_SIZE]
            mbkm.partial_fit(embedding_matrix[batch_idx])
        epochs_run = epoch + 1

        if report_progress is not None:
            await report_progress(epochs_run, KMEANS_MAX_EPOCHS)

        if prev_centers is not None:
            shift = float(np.linalg.norm(mbkm.cluster_centers_ - prev_centers))
            if shift < KMEANS_TOL:
                break
        prev_centers = mbkm.cluster_centers_.copy()

    log_event(
        "kmeans_completed",
        n_samples=n,
        n_clusters=k,
        epochs_run=epochs_run,
        epochs_max=KMEANS_MAX_EPOCHS,
    )

    if report_progress is not None and epochs_run < KMEANS_MAX_EPOCHS:
        await report_progress(KMEANS_MAX_EPOCHS, KMEANS_MAX_EPOCHS)

    return mbkm.predict(embedding_matrix)


def _group_by_label(labels: np.ndarray) -> list[np.ndarray]:
    """Row indices grouped by cluster label.

    Stable argsort + split-at-boundaries — the canonical numpy
    group-by-integer-label pattern. Stable sort preserves the original
    row order within each label group, and ``np.split`` returns chunks
    in ascending-label order, so this is deterministic without an
    explicit secondary sort.
    """
    order = np.argsort(labels, kind="stable")
    sorted_labels = labels[order]
    boundaries = np.where(np.diff(sorted_labels) != 0)[0] + 1
    return np.split(order, boundaries)


def _rebalance(
    *,
    chunks: list[np.ndarray],
    tokens_by_row: np.ndarray,
    embedding_matrix: np.ndarray,
    max_tokens: int,
    min_tokens: int,
) -> list[np.ndarray]:
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


def _chunk_tokens(chunk: np.ndarray, tokens_by_row: np.ndarray) -> int:
    return int(tokens_by_row[chunk].sum())


def _split_recursively(
    chunk: np.ndarray,
    tokens_by_row: np.ndarray,
    embedding_matrix: np.ndarray,
    max_tokens: int,
) -> list[np.ndarray]:
    if _chunk_tokens(chunk, tokens_by_row) <= max_tokens or len(chunk) < 2:
        return [chunk]
    ordered = np.sort(chunk)
    matrix = embedding_matrix[ordered]
    km = KMeans(n_clusters=2, random_state=KMEANS_SEED, n_init=1)
    labels = km.fit_predict(matrix)
    part_a = ordered[labels == 0]
    part_b = ordered[labels == 1]
    # Degenerate: all ideas collapsed to one label. Split by halves
    # as a deterministic fallback so recursion terminates.
    if len(part_a) == 0 or len(part_b) == 0:
        mid = len(ordered) // 2
        part_a, part_b = ordered[:mid], ordered[mid:]
    return _split_recursively(part_a, tokens_by_row, embedding_matrix, max_tokens) + (
        _split_recursively(part_b, tokens_by_row, embedding_matrix, max_tokens)
    )


def _merge_undersize(
    chunks: list[np.ndarray],
    tokens_by_row: np.ndarray,
    embedding_matrix: np.ndarray,
    min_tokens: int,
    max_tokens: int,
) -> list[np.ndarray]:
    if len(chunks) <= 1:
        return chunks

    centroids = np.asarray(
        [embedding_matrix[c].mean(axis=0) for c in chunks], dtype=np.float32
    )
    normalized_centroids = _normalize_rows(centroids)
    sizes = np.asarray(
        [_chunk_tokens(c, tokens_by_row) for c in chunks], dtype=np.int64
    )

    while True:
        under_mask = sizes < min_tokens
        if not under_mask.any():
            break
        # Deterministic pick: smallest chunk first, ties by smallest idea_id
        # in the chunk. ``min`` with a tuple key expresses the two-level
        # comparison cleanly; the iterable is small (only undersize chunks).
        src = int(
            min(
                np.where(under_mask)[0],
                key=lambda i: (int(sizes[i]), int(chunks[i].min())),
            )
        )

        valid = (np.arange(len(sizes)) != src) & (sizes + sizes[src] <= max_tokens)
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

        merged = np.sort(np.concatenate([chunks[src], chunks[nearest]]))
        merged_centroid = embedding_matrix[merged].mean(axis=0)
        merged_size = int(sizes[src] + sizes[nearest])

        # Drop the two merged chunks, append the result. Centroids and
        # sizes stay in lockstep with chunks via ``np.delete``.
        to_drop = [src, nearest]
        chunks = [c for i, c in enumerate(chunks) if i not in {src, nearest}] + [merged]
        centroids = np.vstack(
            [np.delete(centroids, to_drop, axis=0), merged_centroid[None, :]]
        )
        normalized_centroids = _normalize_rows(centroids)
        sizes = np.append(np.delete(sizes, to_drop), merged_size)

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
