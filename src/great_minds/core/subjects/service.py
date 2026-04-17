"""Source card extraction service.

Reads a raw document, runs the source_card LLM prompt, and produces:
- a SourceCard (Ideas with their anchors nested inline) written to
  .compile/<brain_id>/source_cards.jsonl
- a doc_metadata dict for Document.extra_metadata

The LLM emits scratch IDs (i1) for ideas within its own output; this
service rewrites them to deterministic uuid5s and mints anchor UUIDs
from (document_id, claim) before writing anything persistent.
SourceCard is always UUID-shaped.

Citation is doc-level: each anchor carries document_id and the LLM's
quote text (for writer context), but no precise offsets. Passage-level
precision is deferred — see project_chunk_architecture memory.
"""

import json
import uuid
from dataclasses import dataclass
from pathlib import Path

from openai import AsyncOpenAI
from pydantic import BaseModel, ValidationError

from great_minds.core.brain_utils import (
    api_call,
    extract_content,
    parse_frontmatter,
    strip_json_fencing,
)
from great_minds.core.llm import EXTRACT_MODEL
from great_minds.core.subjects.schemas import (
    Idea,
    SourceAnchor,
    SourceCard,
    SourceType,
    SubjectKind,
)
from great_minds.core.telemetry import log_event

# Stable namespaces for content-addressable uuid5 generation.
# Picked once; do not change — downstream IDs depend on these.
_DOCUMENT_NAMESPACE = uuid.UUID("d2f9e61b-2a3b-4a3e-9e6a-6f7d1a2c5b40")
_ANCHOR_NAMESPACE = uuid.UUID("6b3f4ef2-7a1a-4b0e-9e2a-1c0f4d8a7e30")
_IDEA_NAMESPACE = uuid.UUID("8d1f7a04-2c85-4e72-b9c1-3f8d7a5e4b90")

EXTRACTION_VERSION = 1
MAX_OUTPUT_TOKENS = 8000
PARSE_MAX_RETRIES = 2  # includes the first attempt

_VALID_KINDS = {k.value for k in SubjectKind}

_PROMPT_PATH = Path(__file__).parent.parent / "default_prompts" / "source_card.md"


# --- LLM output shape (internal, scratch IDs) --------------------------------


class _RawAnchor(BaseModel):
    claim: str
    quote: str


class _RawIdea(BaseModel):
    id: str
    kind: SubjectKind
    label: str
    description: str
    anchors: list[_RawAnchor]


class _RawExtraction(BaseModel):
    doc_metadata: dict
    ideas: list[_RawIdea]


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
    source_type: SourceType,
    title: str,
    author: str,
    date: str,
    body: str,
) -> ExtractionResult:
    """Run the extraction prompt on one doc and build a SourceCard.

    Ideas with zero anchors are dropped with a log (the prompt forbids
    zero-anchor ideas, but we defend in depth). No quote resolution is
    performed — anchors are trusted at the LLM's word.
    """
    system_prompt = _PROMPT_PATH.read_text(encoding="utf-8")
    user_content = (
        f"Title: {title or 'unknown'}\n"
        f"Author: {author or 'unknown'}\n"
        f"Date: {date or 'unknown'}\n\n"
        f"---\n\n{body}"
    )

    parsed = await _call_and_parse(
        client,
        document_id=document_id,
        system_prompt=system_prompt,
        user_content=user_content,
    )

    card = _build_source_card(
        raw=parsed,
        document_id=document_id,
        brain_id=brain_id,
        source_type=source_type,
    )

    total_anchors = sum(len(idea.anchors) for idea in card.ideas)
    raw_anchors = sum(len(idea.anchors) for idea in parsed.ideas)
    log_event(
        "source_card_extracted",
        document_id=str(document_id),
        brain_id=str(brain_id),
        source_type=source_type.value,
        ideas=len(card.ideas),
        anchors=total_anchors,
        raw_ideas=len(parsed.ideas),
        raw_anchors=raw_anchors,
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
    source_type = SourceType(fm["source_type"])
    result = await extract_source_card(
        client,
        document_id=document_id,
        brain_id=brain_id,
        source_type=source_type,
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


async def _call_and_parse(
    client: AsyncOpenAI,
    *,
    document_id: uuid.UUID,
    system_prompt: str,
    user_content: str,
) -> "_RawExtraction":
    """Make the extraction call; retry on JSON parse or validation error.

    LLM output is occasionally malformed (truncated strings, invalid
    structure) in a way that's transient — same inputs often succeed on
    the next call. Retry once to absorb that noise.
    """
    last_err: Exception | None = None
    for attempt in range(1, PARSE_MAX_RETRIES + 1):
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

        choice = response.choices[0] if response.choices else None
        finish_reason = getattr(choice, "finish_reason", None) if choice else None
        usage = getattr(response, "usage", None)
        output_tokens = getattr(usage, "completion_tokens", None) if usage else None

        raw = strip_json_fencing(text)
        try:
            data = json.loads(raw)
            _coerce_unknown_kinds(data, document_id)
            return _RawExtraction(**data)
        except (json.JSONDecodeError, ValidationError) as e:
            last_err = e
            log_event(
                "extraction_parse_retry",
                level=30,  # WARNING
                document_id=str(document_id),
                attempt=attempt,
                max_attempts=PARSE_MAX_RETRIES,
                error_class=type(e).__name__,
                finish_reason=finish_reason,
                output_tokens=output_tokens,
                raw_tail=raw[-200:],
            )
    raise RuntimeError(
        f"extraction parse failed after {PARSE_MAX_RETRIES} attempts "
        f"for document {document_id}"
    ) from last_err


def _coerce_unknown_kinds(data: dict, document_id: uuid.UUID) -> None:
    """Replace Idea kinds not in SubjectKind with 'other' before validation.

    The LLM occasionally invents finer-grained kinds ('initiative',
    'strategy'). Rather than failing the whole extraction, fall back to
    'other' and log so we can see how often it happens.
    """
    for idea in data.get("ideas", []):
        kind = idea.get("kind")
        if kind not in _VALID_KINDS:
            log_event(
                "idea_kind_coerced",
                level=30,  # WARNING
                document_id=str(document_id),
                original_kind=kind,
                label=idea.get("label"),
            )
            idea["kind"] = SubjectKind.OTHER.value


def _build_source_card(
    *,
    raw: _RawExtraction,
    document_id: uuid.UUID,
    brain_id: uuid.UUID,
    source_type: SourceType,
) -> SourceCard:
    ideas: list[Idea] = []
    for raw_idea in raw.ideas:
        if not raw_idea.anchors:
            log_event(
                "idea_dropped_no_anchors",
                level=30,  # WARNING
                document_id=str(document_id),
                scratch_id=raw_idea.id,
                label=raw_idea.label,
            )
            continue
        idea_id = uuid.uuid5(
            _IDEA_NAMESPACE,
            f"{document_id}:{raw_idea.label}:{raw_idea.kind}",
        )
        anchors = [
            SourceAnchor(
                anchor_id=uuid.uuid5(
                    _ANCHOR_NAMESPACE, f"{document_id}:{raw_anchor.claim}"
                ),
                document_id=document_id,
                claim=raw_anchor.claim,
                quote=raw_anchor.quote,
            )
            for raw_anchor in raw_idea.anchors
        ]
        ideas.append(
            Idea(
                idea_id=idea_id,
                kind=raw_idea.kind,
                label=raw_idea.label,
                description=raw_idea.description,
                anchors=anchors,
            )
        )

    return SourceCard(
        document_id=document_id,
        brain_id=brain_id,
        extraction_version=EXTRACTION_VERSION,
        source_type=source_type,
        ideas=ideas,
    )
