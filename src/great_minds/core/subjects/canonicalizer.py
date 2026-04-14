"""Canonicalization service.

Reads source_cards.jsonl, embeds each Idea on `label + scope_note`,
builds a similarity-threshold graph, finds connected components, and
lets an LLM refine each component into one or more WikiSubjects
(handling polysemy splits where scope_notes diverge).

Writes subjects.jsonl (authoritative) and back-fills Idea.subject_id
into source_cards.jsonl.

Storage invariant matches the extractor: JSONL in .compile/<brain_id>/.
Postgres is a rebuildable cache; not written here.
"""

import asyncio
import json
import math
import re
import uuid
from dataclasses import dataclass
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
from great_minds.core.llm import EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, EXTRACT_MODEL
from great_minds.core.subjects.schemas import (
    ArticleStatus,
    Idea,
    SourceCard,
    SubjectKind,
    WikiSubject,
)
from great_minds.core.telemetry import log_event

SIMILARITY_THRESHOLD = 0.80
EMBED_BATCH_SIZE = 50
EMBED_MAX_RETRIES = 3
REFINE_CONCURRENCY = 10
REFINE_MAX_TOKENS = 4000

_PROMPT_PATH = Path(__file__).parent.parent / "default_prompts" / "canonicalize.md"


# --- LLM output shape (internal) ---------------------------------------------


class _RefinedSubject(BaseModel):
    canonical_label: str
    kind: SubjectKind
    canonical_scope_note: str
    member_ids: list[str]


class _RefinementResponse(BaseModel):
    subjects: list[_RefinedSubject]


@dataclass
class CanonicalizationResult:
    subjects: list[WikiSubject]
    idea_to_subject: dict[uuid.UUID, uuid.UUID]
    n_clusters: int
    n_singletons: int


# --- Public API --------------------------------------------------------------


async def canonicalize(
    client: AsyncOpenAI,
    *,
    brain_id: uuid.UUID,
    threshold: float = SIMILARITY_THRESHOLD,
    refine_concurrency: int = REFINE_CONCURRENCY,
) -> CanonicalizationResult:
    """Run the full canonicalization pipeline for a brain's source cards.

    Steps: load cards → embed Ideas → threshold graph → connected
    components → LLM refine each multi-member cluster → write
    subjects.jsonl and back-fill source_cards.jsonl.
    """
    cards = _load_source_cards(brain_id)
    ideas_flat = [
        (card.document_id, idea)
        for card in cards
        for idea in card.ideas
    ]
    if not ideas_flat:
        log_event("canonicalize_empty_input", brain_id=str(brain_id))
        return CanonicalizationResult(
            subjects=[], idea_to_subject={}, n_clusters=0, n_singletons=0
        )

    texts = [f"{idea.label}. {idea.scope_note}" for _, idea in ideas_flat]
    vectors = await _embed_ideas(client, texts)

    clusters = _cluster_by_threshold(vectors, threshold)

    log_event(
        "canonicalize_clusters_formed",
        brain_id=str(brain_id),
        ideas=len(ideas_flat),
        clusters=len(clusters),
        singletons=sum(1 for c in clusters if len(c) == 1),
        largest=max(len(c) for c in clusters),
        threshold=threshold,
    )

    sem = asyncio.Semaphore(refine_concurrency)
    cluster_tasks = [
        _subject_from_cluster(client, sem, cluster_indices, ideas_flat, brain_id)
        for cluster_indices in clusters
    ]
    per_cluster_results = await asyncio.gather(*cluster_tasks)

    subjects: list[WikiSubject] = []
    idea_to_subject: dict[uuid.UUID, uuid.UUID] = {}
    for cluster_subjects in per_cluster_results:
        for subj, member_idea_ids in cluster_subjects:
            subjects.append(subj)
            for iid in member_idea_ids:
                idea_to_subject[iid] = subj.subject_id

    _dedupe_slugs(subjects)
    _write_subjects(brain_id, subjects)
    _backfill_idea_subject_ids(brain_id, idea_to_subject)

    log_event(
        "canonicalize_completed",
        brain_id=str(brain_id),
        ideas=len(ideas_flat),
        subjects=len(subjects),
    )

    return CanonicalizationResult(
        subjects=subjects,
        idea_to_subject=idea_to_subject,
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
                "canonicalize_embed_retry",
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


def _cluster_by_threshold(vectors: np.ndarray, threshold: float) -> list[list[int]]:
    """Threshold similarity graph → connected components.

    Returns list of clusters; each cluster is a list of Idea indices
    into the input vectors matrix.
    """
    sim = vectors @ vectors.T
    adj = sim >= threshold
    np.fill_diagonal(adj, False)
    n, labels = connected_components(csr_matrix(adj), directed=False)

    clusters: dict[int, list[int]] = {}
    for idx, cluster_id in enumerate(labels):
        clusters.setdefault(int(cluster_id), []).append(idx)
    return list(clusters.values())


# --- Cluster → subject(s) ---------------------------------------------------


async def _subject_from_cluster(
    client: AsyncOpenAI,
    sem: asyncio.Semaphore,
    indices: list[int],
    ideas_flat: list[tuple[uuid.UUID, Idea]],
    brain_id: uuid.UUID,
) -> list[tuple[WikiSubject, list[uuid.UUID]]]:
    """Produce 1+ WikiSubjects from a cluster.

    Singletons skip the LLM call. Multi-member clusters are refined via
    the canonicalize prompt, which may split into multiple subjects for
    polysemy.
    """
    members = [ideas_flat[i] for i in indices]

    if len(members) == 1:
        doc_id, idea = members[0]
        subject = _build_subject(
            brain_id=brain_id,
            canonical_label=idea.label,
            kind=idea.kind,
            scope_note=idea.scope_note,
            members=[(doc_id, idea)],
        )
        return [(subject, [idea.idea_id])]

    async with sem:
        refined = await _refine_cluster_with_llm(client, members)

    # Map local scratch ids (i0, i1, ...) back to members
    idea_by_local_id = {f"i{i}": members[i] for i in range(len(members))}
    assigned: set[str] = set()
    out: list[tuple[WikiSubject, list[uuid.UUID]]] = []
    for rs in refined.subjects:
        member_pairs: list[tuple[uuid.UUID, Idea]] = []
        member_idea_ids: list[uuid.UUID] = []
        for local_id in rs.member_ids:
            if local_id not in idea_by_local_id:
                log_event(
                    "canonicalize_unknown_member_id",
                    level=30,
                    local_id=local_id,
                )
                continue
            if local_id in assigned:
                log_event(
                    "canonicalize_duplicate_member_id",
                    level=30,
                    local_id=local_id,
                )
                continue
            assigned.add(local_id)
            pair = idea_by_local_id[local_id]
            member_pairs.append(pair)
            member_idea_ids.append(pair[1].idea_id)
        if not member_pairs:
            continue
        subject = _build_subject(
            brain_id=brain_id,
            canonical_label=rs.canonical_label,
            kind=rs.kind,
            scope_note=rs.canonical_scope_note,
            members=member_pairs,
        )
        out.append((subject, member_idea_ids))

    # Any unassigned Ideas get their own subject (shouldn't happen if
    # the LLM follows the prompt, but be safe)
    for local_id, pair in idea_by_local_id.items():
        if local_id in assigned:
            continue
        doc_id, idea = pair
        log_event(
            "canonicalize_unassigned_idea",
            level=30,
            local_id=local_id,
            label=idea.label,
        )
        fallback = _build_subject(
            brain_id=brain_id,
            canonical_label=idea.label,
            kind=idea.kind,
            scope_note=idea.scope_note,
            members=[pair],
        )
        out.append((fallback, [idea.idea_id]))

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
        lines.append(f"scope: {idea.scope_note}")
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
                "canonicalize_kind_coerced",
                level=30,
                original_kind=subj.get("kind"),
                label=subj.get("canonical_label"),
            )
            subj["kind"] = SubjectKind.OTHER.value


# --- Subject building -------------------------------------------------------


def _build_subject(
    *,
    brain_id: uuid.UUID,
    canonical_label: str,
    kind: SubjectKind,
    scope_note: str,
    members: list[tuple[uuid.UUID, Idea]],
) -> WikiSubject:
    supporting_docs = sorted({doc_id for doc_id, _ in members})
    evidence_anchors = sorted(
        {aid for _, idea in members for aid in idea.anchor_ids}
    )
    return WikiSubject(
        subject_id=uuid.uuid4(),
        brain_id=brain_id,
        kind=kind,
        canonical_label=canonical_label,
        slug=_slugify(canonical_label),
        scope_note=scope_note,
        supporting_document_ids=supporting_docs,
        evidence_anchor_ids=evidence_anchors,
        article_status=ArticleStatus.NO_ARTICLE,
    )


_SLUG_STRIP_RE = re.compile(r"[^\w\s-]")
_SLUG_DASH_RE = re.compile(r"[\s_-]+")


def _slugify(label: str) -> str:
    slug = _SLUG_STRIP_RE.sub("", label.lower().strip())
    slug = _SLUG_DASH_RE.sub("-", slug).strip("-")
    return slug or "unnamed"


def _dedupe_slugs(subjects: list[WikiSubject]) -> None:
    """Mutate subjects in place so every slug is unique.

    Collisions occur when canonicalization emits two subjects whose
    canonical_labels slugify identically — either from two parallel
    cluster refinements or from a polysemy split that keeps the same
    label. First occurrence keeps the base slug; later occurrences get
    a kind suffix (e.g. 'socialist-reconstruction-work') or, if that
    still collides, a short subject_id suffix.
    """
    seen: set[str] = set()
    for subj in subjects:
        base = subj.slug
        candidate = base
        if candidate in seen:
            candidate = f"{base}-{subj.kind.value}"
            if candidate in seen:
                candidate = f"{base}-{str(subj.subject_id)[:6]}"
        if candidate != base:
            log_event(
                "slug_collision_resolved",
                level=30,
                subject_id=str(subj.subject_id),
                original_slug=base,
                new_slug=candidate,
                kind=subj.kind.value,
            )
            subj.slug = candidate
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


def _write_subjects(brain_id: uuid.UUID, subjects: list[WikiSubject]) -> None:
    path = _compile_dir(brain_id) / "subjects.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for subj in subjects:
            f.write(subj.model_dump_json() + "\n")


def _backfill_idea_subject_ids(
    brain_id: uuid.UUID,
    idea_to_subject: dict[uuid.UUID, uuid.UUID],
) -> None:
    """Read source_cards.jsonl, fill Idea.subject_id, write back."""
    path = _compile_dir(brain_id) / "source_cards.jsonl"
    cards: list[dict] = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            stripped = line.strip()
            if stripped:
                cards.append(json.loads(stripped))

    lookup = {str(k): str(v) for k, v in idea_to_subject.items()}
    for card in cards:
        for idea in card.get("ideas", []):
            iid = idea.get("idea_id")
            if iid in lookup:
                idea["subject_id"] = lookup[iid]

    with path.open("w", encoding="utf-8") as f:
        for card in cards:
            f.write(json.dumps(card) + "\n")
