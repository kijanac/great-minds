"""Source card extraction service.

Reads a raw document, runs the source_card LLM prompt, and produces:
- a SourceCard (candidates + anchors) written to
  .compile/<brain_id>/source_cards.jsonl
- a doc_metadata dict for Document.extra_metadata

The LLM emits scratch IDs (c1/a1) for cross-referencing within its own
output; this service rewrites them to deterministic uuid5s before writing
anything persistent. SourceCard is always UUID-shaped.

Citation is doc-level: each anchor carries document_id and the LLM's
quote text (for writer context), but no precise offsets. Passage-level
precision is deferred — see project_chunk_architecture memory.
"""

import json
import uuid
from dataclasses import dataclass
from pathlib import Path

from openai import AsyncOpenAI
from pydantic import BaseModel

from great_minds.core.brain_utils import (
    api_call,
    extract_content,
    parse_frontmatter,
    strip_json_fencing,
)
from great_minds.core.llm import EXTRACT_MODEL
from great_minds.core.subjects.schemas import (
    CandidateSubject,
    SourceAnchor,
    SourceCard,
    SubjectKind,
)
from great_minds.core.telemetry import log_event

# Stable namespaces for content-addressable uuid5 generation.
# Picked once; do not change — downstream IDs depend on these.
_DOCUMENT_NAMESPACE = uuid.UUID("d2f9e61b-2a3b-4a3e-9e6a-6f7d1a2c5b40")
_ANCHOR_NAMESPACE = uuid.UUID("6b3f4ef2-7a1a-4b0e-9e2a-1c0f4d8a7e30")
_CANDIDATE_NAMESPACE = uuid.UUID("8d1f7a04-2c85-4e72-b9c1-3f8d7a5e4b90")

EXTRACTION_VERSION = 1
MAX_OUTPUT_TOKENS = 8000

_VALID_KINDS = {k.value for k in SubjectKind}

_PROMPT_PATH = Path(__file__).parent.parent / "default_prompts" / "source_card.md"


# --- LLM output shape (internal, scratch IDs) --------------------------------


class _RawAnchor(BaseModel):
    id: str
    claim: str
    quote: str


class _RawCandidate(BaseModel):
    id: str
    kind: SubjectKind
    label: str
    scope_note: str
    anchor_refs: list[str]


class _RawExtraction(BaseModel):
    doc_metadata: dict
    candidates: list[_RawCandidate]
    anchors: list[_RawAnchor]


@dataclass
class ExtractionResult:
    source_card: SourceCard
    doc_metadata: dict


# --- Public API --------------------------------------------------------------


def document_id_for(brain_id: uuid.UUID, file_path: str) -> uuid.UUID:
    """Deterministic document_id for a (brain, file path) pair."""
    return uuid.uuid5(_DOCUMENT_NAMESPACE, f"{brain_id}:{file_path}")


async def extract_source_card(
    client: AsyncOpenAI,
    *,
    document_id: uuid.UUID,
    brain_id: uuid.UUID,
    title: str,
    author: str,
    date: str,
    body: str,
) -> ExtractionResult:
    """Run the extraction prompt on one doc and build a SourceCard.

    Candidates whose anchor_refs all miss the anchors list are dropped
    with a log. No quote resolution is performed — anchors are trusted
    at the LLM's word.
    """
    system_prompt = _PROMPT_PATH.read_text(encoding="utf-8")
    user_content = (
        f"Title: {title or 'unknown'}\n"
        f"Author: {author or 'unknown'}\n"
        f"Date: {date or 'unknown'}\n\n"
        f"---\n\n{body}"
    )

    response = await api_call(
        client,
        model=EXTRACT_MODEL,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ],
        temperature=0.2,
        max_tokens=MAX_OUTPUT_TOKENS,
        extra_body={"reasoning": {"enabled": False}},
        response_format={"type": "json_object"},
    )

    text = extract_content(response)
    if not text:
        raise RuntimeError(f"empty extraction response for document {document_id}")

    raw = strip_json_fencing(text)
    data = json.loads(raw)
    _coerce_unknown_kinds(data, document_id)
    parsed = _RawExtraction(**data)

    card = _build_source_card(raw=parsed, document_id=document_id, brain_id=brain_id)

    log_event(
        "source_card_extracted",
        document_id=str(document_id),
        brain_id=str(brain_id),
        candidates=len(card.candidates),
        anchors=len(card.anchors),
        raw_candidates=len(parsed.candidates),
        raw_anchors=len(parsed.anchors),
    )

    return ExtractionResult(source_card=card, doc_metadata=parsed.doc_metadata)


async def extract_from_file(
    client: AsyncOpenAI,
    *,
    brain_id: uuid.UUID,
    file_path: Path,
    write_card: bool = True,
) -> ExtractionResult:
    """Read a markdown file, extract its source card, optionally write to JSONL.

    When running extractions in parallel, callers should pass write_card=False
    and write results serially afterwards; write_source_card does a
    read-all-replace-all cycle that is not safe under concurrent writes.
    """
    content = file_path.read_text(encoding="utf-8")
    fm, body = parse_frontmatter(content)

    document_id = document_id_for(brain_id, file_path.as_posix())
    result = await extract_source_card(
        client,
        document_id=document_id,
        brain_id=brain_id,
        title=fm.get("title") or "",
        author=fm.get("author") or "",
        date=str(fm.get("date") or ""),
        body=body,
    )
    if write_card:
        write_source_card(brain_id=brain_id, card=result.source_card)
    return result


def write_source_card(*, brain_id: uuid.UUID, card: SourceCard) -> None:
    """Upsert a source card into .compile/<brain_id>/source_cards.jsonl.

    Replaces any existing entry with the same (document_id,
    extraction_version); otherwise appends.
    """
    path = Path(".compile") / str(brain_id) / "source_cards.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)

    existing: list[dict] = []
    if path.exists():
        with path.open("r", encoding="utf-8") as f:
            for line in f:
                stripped = line.strip()
                if stripped:
                    existing.append(json.loads(stripped))

    card_key = (str(card.document_id), card.extraction_version)
    kept = [
        c
        for c in existing
        if (c.get("document_id"), c.get("extraction_version")) != card_key
    ]
    kept.append(json.loads(card.model_dump_json()))

    with path.open("w", encoding="utf-8") as f:
        for c in kept:
            f.write(json.dumps(c) + "\n")


# --- Internal ---------------------------------------------------------------


def _coerce_unknown_kinds(data: dict, document_id: uuid.UUID) -> None:
    """Replace candidate kinds not in SubjectKind with 'other' before validation.

    The LLM occasionally invents finer-grained kinds ('initiative',
    'strategy'). Rather than failing the whole extraction, fall back to
    'other' and log so we can see how often it happens.
    """
    for cand in data.get("candidates", []):
        kind = cand.get("kind")
        if kind not in _VALID_KINDS:
            log_event(
                "candidate_kind_coerced",
                level=30,  # WARNING
                document_id=str(document_id),
                original_kind=kind,
                label=cand.get("label"),
            )
            cand["kind"] = SubjectKind.OTHER.value


def _build_source_card(
    *,
    raw: _RawExtraction,
    document_id: uuid.UUID,
    brain_id: uuid.UUID,
) -> SourceCard:
    anchor_id_map: dict[str, uuid.UUID] = {}
    resolved_anchors: list[SourceAnchor] = []
    for raw_anchor in raw.anchors:
        anchor_id = uuid.uuid5(_ANCHOR_NAMESPACE, f"{document_id}:{raw_anchor.claim}")
        anchor_id_map[raw_anchor.id] = anchor_id
        resolved_anchors.append(
            SourceAnchor(
                anchor_id=anchor_id,
                document_id=document_id,
                claim=raw_anchor.claim,
                quote=raw_anchor.quote,
            )
        )

    candidates: list[CandidateSubject] = []
    for raw_cand in raw.candidates:
        mapped_refs = [
            anchor_id_map[ref] for ref in raw_cand.anchor_refs if ref in anchor_id_map
        ]
        if not mapped_refs:
            log_event(
                "candidate_dropped_no_anchors",
                level=30,  # WARNING
                document_id=str(document_id),
                scratch_id=raw_cand.id,
                label=raw_cand.label,
            )
            continue
        candidate_id = uuid.uuid5(
            _CANDIDATE_NAMESPACE,
            f"{document_id}:{raw_cand.label}:{raw_cand.kind}",
        )
        candidates.append(
            CandidateSubject(
                candidate_id=candidate_id,
                kind=raw_cand.kind,
                label=raw_cand.label,
                scope_note=raw_cand.scope_note,
                anchor_ids=mapped_refs,
            )
        )

    return SourceCard(
        document_id=document_id,
        brain_id=brain_id,
        extraction_version=EXTRACTION_VERSION,
        candidates=candidates,
        anchors=resolved_anchors,
    )
