"""Distillation service.

Reads source_cards.jsonl, embeds each Idea on `label + description`,
builds a similarity-threshold graph, finds connected components, and
lets an LLM refine each component into one or more Concepts (handling
polysemy splits where descriptions diverge).

Writes subjects.jsonl (authoritative) and back-fills Idea.concept_id
into source_cards.jsonl.

Storage invariant matches the extractor: JSONL in .compile/<brain_id>/.
Postgres is a rebuildable cache; not written here.
"""

import asyncio
import hashlib
import json
import math
import re
import uuid
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from openai import AsyncOpenAI
from pydantic import BaseModel
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import connected_components

from great_minds.core.brain_utils import (
    api_call,
    extract_content,
    strip_json_fencing,
)
from great_minds.core.db import session_maker
from great_minds.core.ids import uuid7
from great_minds.core.llm import EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, EXTRACT_MODEL
from great_minds.core.subjects.concept_repository import (
    existing_slugs,
    reconcile_concept_ids,
    registry_diff,
    retired_slugs,
    upsert_concepts,
)
from great_minds.core.subjects.embedding_store import (
    DEFAULT_TOP_K,
    query_neighbor_edges,
    upsert_idea_embeddings,
)
from great_minds.core.subjects.schemas import (
    Concept,
    Idea,
    SourceCard,
    SubjectKind,
)
from great_minds.core.telemetry import log_event

SIMILARITY_THRESHOLD = 0.80
EMBED_BATCH_SIZE = 50
EMBED_MAX_RETRIES = 3
REFINE_CONCURRENCY = 10
REFINE_MAX_TOKENS = 4000
NEIGHBOR_TOP_K = DEFAULT_TOP_K

_PROMPT_PATH = Path(__file__).parent.parent / "default_prompts" / "distill.md"


# --- LLM output shape (internal) ---------------------------------------------


class _RefinedConcept(BaseModel):
    canonical_label: str
    kind: SubjectKind
    description: str
    member_ids: list[str]


class _RefinementResponse(BaseModel):
    subjects: list[_RefinedConcept]


@dataclass
class DistillationResult:
    concepts: list[Concept]
    idea_to_concept: dict[uuid.UUID, uuid.UUID]
    n_clusters: int
    n_singletons: int
    added: list[Concept] = field(default_factory=list)
    dirty: list[Concept] = field(default_factory=list)
    unchanged: list[Concept] = field(default_factory=list)
    retired: list[tuple[uuid.UUID, str]] = field(default_factory=list)


# --- Public API --------------------------------------------------------------


async def distill(
    client: AsyncOpenAI,
    *,
    brain_id: uuid.UUID,
    threshold: float = SIMILARITY_THRESHOLD,
    refine_concurrency: int = REFINE_CONCURRENCY,
) -> DistillationResult:
    """Full distillation pipeline for a brain's source cards.

    Loads ideas from source_cards.jsonl, runs the clustering pipeline,
    writes subjects.jsonl and back-fills source_cards.jsonl with
    concept_id references.
    """
    cards = _load_source_cards(brain_id)
    ideas_flat = [
        (card.document_id, idea)
        for card in cards
        for idea in card.ideas
    ]
    if not ideas_flat:
        log_event("distill_empty_input", brain_id=str(brain_id))
        return DistillationResult(
            concepts=[], idea_to_concept={}, n_clusters=0, n_singletons=0
        )

    extraction_version = cards[0].extraction_version
    result = await cluster_ideas(
        client,
        brain_id=brain_id,
        ideas_flat=ideas_flat,
        threshold=threshold,
        refine_concurrency=refine_concurrency,
        extraction_version=extraction_version,
    )

    _dedupe_slugs(result.concepts)

    async with session_maker() as session:
        cached = await existing_slugs(session, brain_id)
        remap = reconcile_concept_ids(result.concepts, cached)
        if remap:
            _remap_idea_to_concept(result.idea_to_concept, remap)
            log_event(
                "distill_slug_continuity_reused_ids",
                brain_id=str(brain_id),
                count=len(remap),
            )
        # Snapshot the diff BEFORE upserting so "added" and "dirty" reflect
        # the prior registry state, not our own upsert.
        added, dirty, unchanged = await registry_diff(
            session, brain_id, result.concepts
        )
        live_slugs = {c.slug for c in result.concepts}
        retired = await retired_slugs(session, brain_id, live_slugs)
        await upsert_concepts(session, brain_id, result.concepts)

    result.added = added
    result.dirty = dirty
    result.unchanged = unchanged
    result.retired = retired

    _write_concepts(brain_id, result.concepts)
    _backfill_idea_concept_ids(brain_id, result.idea_to_concept)

    log_event(
        "distill_completed",
        brain_id=str(brain_id),
        ideas=len(ideas_flat),
        concepts=len(result.concepts),
        added=len(added),
        dirty=len(dirty),
        unchanged=len(unchanged),
        retired=len(retired),
    )
    return result


def _remap_idea_to_concept(
    idea_to_concept: dict[uuid.UUID, uuid.UUID],
    remap: dict[uuid.UUID, uuid.UUID],
) -> None:
    """Replace any speculative concept_ids with their reconciled durable ids."""
    for iid, old_cid in list(idea_to_concept.items()):
        durable = remap.get(old_cid)
        if durable is not None:
            idea_to_concept[iid] = durable


async def cluster_ideas(
    client: AsyncOpenAI,
    *,
    brain_id: uuid.UUID,
    ideas_flat: list[tuple[uuid.UUID, Idea]],
    threshold: float,
    refine_concurrency: int = REFINE_CONCURRENCY,
    extraction_version: int = 1,
) -> DistillationResult:
    """Core ANN-based clustering: embed → upsert → top-K query → LLM refine.

    No file IO. Callers (including distill() and tests) use this
    directly with pre-loaded ideas. Always uses pgvector; no in-memory
    fallback.
    """
    if not ideas_flat:
        return DistillationResult(
            concepts=[], idea_to_concept={}, n_clusters=0, n_singletons=0
        )

    texts = [f"{idea.label}. {idea.description}" for _, idea in ideas_flat]
    vectors = await _embed_ideas(client, texts)

    async with session_maker() as session:
        await upsert_idea_embeddings(
            session,
            brain_id=brain_id,
            ideas_flat=ideas_flat,
            vectors=vectors,
            extraction_version=extraction_version,
        )

    edges = await query_neighbor_edges(
        brain_id=brain_id,
        ideas_flat=ideas_flat,
        k=NEIGHBOR_TOP_K,
        threshold=threshold,
    )
    clusters = _clusters_from_edges(len(ideas_flat), edges)

    log_event(
        "distill_clusters_formed",
        brain_id=str(brain_id),
        ideas=len(ideas_flat),
        clusters=len(clusters),
        singletons=sum(1 for c in clusters if len(c) == 1),
        largest=max(len(c) for c in clusters),
        threshold=threshold,
        top_k=NEIGHBOR_TOP_K,
    )

    sem = asyncio.Semaphore(refine_concurrency)
    per_cluster_results = await asyncio.gather(
        *(
            _concepts_from_cluster(client, sem, cluster_indices, ideas_flat, brain_id)
            for cluster_indices in clusters
        )
    )

    concepts: list[Concept] = []
    idea_to_concept: dict[uuid.UUID, uuid.UUID] = {}
    for cluster_concepts in per_cluster_results:
        for concept in cluster_concepts:
            concepts.append(concept)
            for iid in concept.member_idea_ids:
                idea_to_concept[iid] = concept.concept_id

    return DistillationResult(
        concepts=concepts,
        idea_to_concept=idea_to_concept,
        n_clusters=len(clusters),
        n_singletons=sum(1 for c in clusters if len(c) == 1),
    )


# --- Embedding --------------------------------------------------------------


async def _embed_ideas(client: AsyncOpenAI, texts: list[str]) -> np.ndarray:
    """Embed texts in batches via OpenRouter; return (N, D) normalized matrix."""
    all_vectors: list[list[float]] = []
    for start in range(0, len(texts), EMBED_BATCH_SIZE):
        batch = texts[start : start + EMBED_BATCH_SIZE]
        all_vectors.extend(await _embed_batch(client, batch))
    return np.asarray(all_vectors, dtype=np.float32)


async def _embed_batch(client: AsyncOpenAI, texts: list[str]) -> list[list[float]]:
    for attempt in range(1, EMBED_MAX_RETRIES + 1):
        try:
            response = await client.embeddings.create(
                model=EMBEDDING_MODEL, input=texts
            )
            return [
                _truncate_and_normalize(item.embedding, EMBEDDING_DIMENSIONS)
                for item in response.data
            ]
        except Exception as e:
            if attempt == EMBED_MAX_RETRIES:
                raise
            log_event(
                "distill_embed_retry",
                level=30,
                attempt=attempt,
                max_attempts=EMBED_MAX_RETRIES,
                error=str(e)[:200],
            )
            await asyncio.sleep(2**attempt)


def _truncate_and_normalize(embedding: list[float], dims: int) -> list[float]:
    truncated = embedding[:dims]
    norm = math.sqrt(sum(x * x for x in truncated))
    if norm == 0:
        return truncated
    return [x / norm for x in truncated]


# --- Clustering -------------------------------------------------------------


def _clusters_from_edges(
    n: int, edges: list[tuple[int, int]]
) -> list[list[int]]:
    """Build cluster index list from a sparse edge set via connected components."""
    if not edges:
        return [[i] for i in range(n)]
    rows, cols = zip(*edges)
    # Build symmetric sparse adjacency
    data = np.ones(len(edges) * 2, dtype=np.int8)
    rr = np.array(rows + cols, dtype=np.int64)
    cc = np.array(cols + rows, dtype=np.int64)
    adj = csr_matrix((data, (rr, cc)), shape=(n, n))
    _, labels = connected_components(adj, directed=False)

    clusters: dict[int, list[int]] = {}
    for idx, cluster_id in enumerate(labels):
        clusters.setdefault(int(cluster_id), []).append(idx)
    return list(clusters.values())


# --- Cluster → subject(s) ---------------------------------------------------


async def _concepts_from_cluster(
    client: AsyncOpenAI,
    sem: asyncio.Semaphore,
    indices: list[int],
    ideas_flat: list[tuple[uuid.UUID, Idea]],
    brain_id: uuid.UUID,
) -> list[Concept]:
    """Produce 1+ Concepts from a cluster.

    Singletons skip the LLM call. Multi-member clusters are refined via
    the distill prompt, which may split into multiple concepts for
    polysemy.
    """
    members = [ideas_flat[i] for i in indices]

    if len(members) == 1:
        doc_id, idea = members[0]
        concept = _build_concept(
            brain_id=brain_id,
            canonical_label=idea.label,
            kind=idea.kind,
            description=idea.description,
            members=[(doc_id, idea)],
        )
        return [concept]

    async with sem:
        refined = await _refine_cluster_with_llm(client, members)

    # Map local scratch ids (i0, i1, ...) back to members
    idea_by_local_id = {f"i{i}": members[i] for i in range(len(members))}
    assigned: set[str] = set()
    out: list[Concept] = []
    for rc in refined.subjects:
        member_pairs: list[tuple[uuid.UUID, Idea]] = []
        for local_id in rc.member_ids:
            if local_id not in idea_by_local_id:
                log_event(
                    "distill_unknown_member_id",
                    level=30,
                    local_id=local_id,
                )
                continue
            if local_id in assigned:
                log_event(
                    "distill_duplicate_member_id",
                    level=30,
                    local_id=local_id,
                )
                continue
            assigned.add(local_id)
            member_pairs.append(idea_by_local_id[local_id])
        if not member_pairs:
            continue
        concept = _build_concept(
            brain_id=brain_id,
            canonical_label=rc.canonical_label,
            kind=rc.kind,
            description=rc.description,
            members=member_pairs,
        )
        out.append(concept)

    # Any unassigned Ideas get their own concept (shouldn't happen if
    # the LLM follows the prompt, but be safe)
    for local_id, pair in idea_by_local_id.items():
        if local_id in assigned:
            continue
        _, idea = pair
        log_event(
            "distill_unassigned_idea",
            level=30,
            local_id=local_id,
            label=idea.label,
        )
        fallback = _build_concept(
            brain_id=brain_id,
            canonical_label=idea.label,
            kind=idea.kind,
            description=idea.description,
            members=[pair],
        )
        out.append(fallback)

    return out


async def _refine_cluster_with_llm(
    client: AsyncOpenAI,
    members: list[tuple[uuid.UUID, Idea]],
) -> _RefinementResponse:
    system_prompt = _PROMPT_PATH.read_text(encoding="utf-8")
    lines = ["Ideas in this cluster:\n"]
    for i, (_, idea) in enumerate(members):
        lines.append(f"id: i{i}")
        lines.append(f"kind: {idea.kind}")
        lines.append(f"label: {idea.label}")
        lines.append(f"description: {idea.description}")
        lines.append("")
    user_content = "\n".join(lines)

    response = await api_call(
        client,
        model=EXTRACT_MODEL,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ],
        temperature=0.2,
        max_tokens=REFINE_MAX_TOKENS,
        extra_body={"reasoning": {"enabled": False}},
        response_format={"type": "json_object"},
    )

    text = extract_content(response)
    if not text:
        raise RuntimeError("empty refinement response")
    raw = strip_json_fencing(text)
    data = json.loads(raw)
    _coerce_unknown_kinds_in_refinement(data)
    return _RefinementResponse(**data)


def _coerce_unknown_kinds_in_refinement(data: dict) -> None:
    valid = {k.value for k in SubjectKind}
    for subj in data.get("subjects", []):
        if subj.get("kind") not in valid:
            log_event(
                "distill_kind_coerced",
                level=30,
                original_kind=subj.get("kind"),
                label=subj.get("canonical_label"),
            )
            subj["kind"] = SubjectKind.OTHER.value


# --- Subject building -------------------------------------------------------


def _build_concept(
    *,
    brain_id: uuid.UUID,
    canonical_label: str,
    kind: SubjectKind,
    description: str,
    members: list[tuple[uuid.UUID, Idea]],
) -> Concept:
    supporting_docs = sorted({doc_id for doc_id, _ in members})
    member_idea_ids = sorted({idea.idea_id for _, idea in members})
    compiled_from_hash = _compute_compiled_from_hash(
        member_idea_ids=member_idea_ids,
        canonical_label=canonical_label,
        description=description,
    )
    return Concept(
        concept_id=uuid7(),
        brain_id=brain_id,
        kind=kind,
        canonical_label=canonical_label,
        slug=_slugify(canonical_label),
        description=description,
        supporting_document_ids=supporting_docs,
        member_idea_ids=member_idea_ids,
        compiled_from_hash=compiled_from_hash,
    )


def _compute_compiled_from_hash(
    *,
    member_idea_ids: list[uuid.UUID],
    canonical_label: str,
    description: str,
) -> str:
    """sha256 over the Concept's rendering inputs.

    Drives Phase 3 dirty-flagging (M5): a Concept whose member set,
    label, or description is unchanged since its last render keeps the
    same hash and can be served from cache. Member IDs are pre-sorted by
    the caller for stability.
    """
    parts = [str(uid) for uid in member_idea_ids] + [canonical_label, description]
    joined = "\x1f".join(parts).encode("utf-8")
    return hashlib.sha256(joined).hexdigest()


_SLUG_STRIP_RE = re.compile(r"[^\w\s-]")
_SLUG_DASH_RE = re.compile(r"[\s_-]+")


def _slugify(label: str) -> str:
    slug = _SLUG_STRIP_RE.sub("", label.lower().strip())
    slug = _SLUG_DASH_RE.sub("-", slug).strip("-")
    return slug or "unnamed"


def _dedupe_slugs(concepts: list[Concept]) -> None:
    """Mutate concepts in place so every slug is unique.

    Collisions occur when distillation emits two concepts whose
    canonical_labels slugify identically — either from two parallel
    cluster refinements or from a polysemy split that keeps the same
    label. First occurrence keeps the base slug; later occurrences get
    a kind suffix (e.g. 'socialist-reconstruction-work') or, if that
    still collides, a short concept_id suffix.
    """
    seen: set[str] = set()
    for concept in concepts:
        base = concept.slug
        candidate = base
        if candidate in seen:
            candidate = f"{base}-{concept.kind.value}"
            if candidate in seen:
                candidate = f"{base}-{str(concept.concept_id)[:6]}"
        if candidate != base:
            log_event(
                "slug_collision_resolved",
                level=30,
                concept_id=str(concept.concept_id),
                original_slug=base,
                new_slug=candidate,
                kind=concept.kind.value,
            )
            concept.slug = candidate
        seen.add(candidate)


# --- IO ---------------------------------------------------------------------


def _compile_dir(brain_id: uuid.UUID) -> Path:
    return Path(".compile") / str(brain_id)


def _load_source_cards(brain_id: uuid.UUID) -> list[SourceCard]:
    path = _compile_dir(brain_id) / "source_cards.jsonl"
    cards: list[SourceCard] = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            stripped = line.strip()
            if stripped:
                cards.append(SourceCard(**json.loads(stripped)))
    return cards


def _write_concepts(brain_id: uuid.UUID, concepts: list[Concept]) -> None:
    path = _compile_dir(brain_id) / "subjects.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for concept in concepts:
            f.write(concept.model_dump_json() + "\n")


def _backfill_idea_concept_ids(
    brain_id: uuid.UUID,
    idea_to_concept: dict[uuid.UUID, uuid.UUID],
) -> None:
    """Read source_cards.jsonl, fill Idea.concept_id, write back."""
    path = _compile_dir(brain_id) / "source_cards.jsonl"
    cards: list[dict] = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            stripped = line.strip()
            if stripped:
                cards.append(json.loads(stripped))

    lookup = {str(k): str(v) for k, v in idea_to_concept.items()}
    for card in cards:
        for idea in card.get("ideas", []):
            iid = idea.get("idea_id")
            if iid in lookup:
                idea["concept_id"] = lookup[iid]

    with path.open("w", encoding="utf-8") as f:
        for card in cards:
            f.write(json.dumps(card) + "\n")
