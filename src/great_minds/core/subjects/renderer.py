"""Article rendering service.

For each Concept, assemble an evidence pack + supporting doc excerpts
+ concept registry, call the writer LLM, and write a markdown article
with YAML frontmatter to wiki/<slug>.md.

The writer gets three kinds of input:
- Evidence anchors (claim + quote) gathered by walking the concept's
  member ideas and collecting each idea's anchors
- Full text of each supporting document, budgeted
- The full concept registry for cross-linking (works up to ~1000 concepts)

Links are standard markdown `[label](wiki/slug.md)`. Citations are doc-
level via markdown footnotes. Broken-link cleanup and fuzzy-match
link insertion across the full wiki run as Phase 4 in the crosslinker.
"""

import asyncio
import json
import uuid
from dataclasses import dataclass
from pathlib import Path

from openai import AsyncOpenAI

from great_minds.core.brain_utils import (
    api_call,
    extract_content,
    parse_frontmatter,
    serialize_frontmatter,
)
from great_minds.core.llm import REASON_MODEL
from great_minds.core.subjects.schemas import (
    Concept,
    SourceAnchor,
    SourceCard,
)
from great_minds.core.subjects.service import document_id_for
from great_minds.core.telemetry import log_event

MAX_SOURCE_CHARS = 30_000
MIN_PER_SOURCE_CHARS = 4_000
WRITER_MAX_TOKENS = 6000

_PROMPT_PATH = Path(__file__).parent.parent / "default_prompts" / "render_article.md"


@dataclass
class DocContext:
    document_id: uuid.UUID
    file_path: str  # relative path used for footnote links (e.g., raw/texts/foo.md)
    title: str
    author: str
    date: str
    body: str


@dataclass
class AnchorWithContext:
    anchor: SourceAnchor
    doc: DocContext


# --- Public API --------------------------------------------------------------


async def render_brain(
    client: AsyncOpenAI,
    *,
    brain_id: uuid.UUID,
    raw_dir: Path,
    wiki_dir: Path,
    only_multi_doc: bool = False,
    limit: int | None = None,
    concurrency: int = 10,
    raw_link_prefix: str = "raw/texts",
) -> list[Path]:
    """Render eligible subjects for a brain, write wiki/<slug>.md files.

    raw_dir is scanned for source files to reconstruct DocContexts.
    raw_link_prefix is used when composing footnote paths in output articles
    (so citations look like `raw/texts/foo.md` regardless of filesystem layout).
    """
    concepts = _load_concepts(brain_id)
    cards = _load_source_cards(brain_id)
    doc_contexts = _build_doc_contexts(brain_id, raw_dir, raw_link_prefix)
    idea_anchor_lookup = _build_idea_anchor_lookup(cards, doc_contexts)

    selected = concepts
    if only_multi_doc:
        selected = [c for c in selected if len(c.supporting_document_ids) > 1]
    if limit is not None:
        selected = selected[:limit]

    print(
        f"Rendering {len(selected)} concept(s) of {len(concepts)} "
        f"(only_multi_doc={only_multi_doc}, concurrency={concurrency})"
    )

    sem = asyncio.Semaphore(concurrency)
    tasks = [
        _render_one(
            client, sem, concept, concepts, idea_anchor_lookup, doc_contexts, wiki_dir
        )
        for concept in selected
    ]
    outcomes = await asyncio.gather(*tasks)
    successful: list[tuple[Concept, Path]] = [
        pair for pair in outcomes if isinstance(pair, tuple)
    ]
    return successful


# --- Core render step --------------------------------------------------------


async def _render_one(
    client: AsyncOpenAI,
    sem: asyncio.Semaphore,
    concept: Concept,
    all_concepts: list[Concept],
    idea_anchor_lookup: dict[uuid.UUID, list[AnchorWithContext]],
    doc_contexts: dict[uuid.UUID, DocContext],
    wiki_dir: Path,
) -> tuple[Concept, Path] | Exception:
    async with sem:
        try:
            anchors: list[AnchorWithContext] = []
            for iid in concept.member_idea_ids:
                anchors.extend(idea_anchor_lookup.get(iid, []))

            supporting_docs = [
                doc_contexts[did]
                for did in concept.supporting_document_ids
                if did in doc_contexts
            ]
            supporting_docs = _apply_char_budget(
                supporting_docs, MAX_SOURCE_CHARS, MIN_PER_SOURCE_CHARS
            )
            registry = [c for c in all_concepts if c.concept_id != concept.concept_id]

            body = await _call_writer(
                client,
                concept=concept,
                anchors=anchors,
                supporting_docs=supporting_docs,
                concept_registry=registry,
            )
            path = _write_article_file(wiki_dir=wiki_dir, concept=concept, body=body)
            log_event(
                "article_rendered",
                concept_id=str(concept.concept_id),
                slug=concept.slug,
                supporting_docs=len(supporting_docs),
                anchors=len(anchors),
                output_chars=len(body),
            )
            print(
                f"  {concept.slug}.md  OK  "
                f"{len(supporting_docs)} docs, {len(anchors)} anchors, "
                f"{len(body)} chars",
                flush=True,
            )
            return (concept, path)
        except Exception as e:
            log_event(
                "article_render_failed",
                level=40,
                concept_id=str(concept.concept_id),
                slug=concept.slug,
                error=str(e)[:300],
            )
            print(
                f"  {concept.slug}.md  FAIL  {type(e).__name__}: {e}",
                flush=True,
            )
            return e


async def _call_writer(
    client: AsyncOpenAI,
    *,
    concept: Concept,
    anchors: list[AnchorWithContext],
    supporting_docs: list[DocContext],
    concept_registry: list[Concept],
) -> str:
    system_prompt = _PROMPT_PATH.read_text(encoding="utf-8")
    user_content = _build_user_content(
        concept=concept,
        anchors=anchors,
        supporting_docs=supporting_docs,
        concept_registry=concept_registry,
    )

    response = await api_call(
        client,
        model=REASON_MODEL,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ],
        temperature=0.3,
        max_tokens=WRITER_MAX_TOKENS,
        extra_body={"reasoning": {"enabled": False}},
    )
    text = extract_content(response)
    if not text:
        raise RuntimeError(f"empty writer response for {concept.concept_id}")
    return text.strip()


# --- User-message assembly --------------------------------------------------


def _build_user_content(
    *,
    concept: Concept,
    anchors: list[AnchorWithContext],
    supporting_docs: list[DocContext],
    concept_registry: list[Concept],
) -> str:
    parts = [
        "# Concept",
        "",
        f"- Kind: {concept.kind}",
        f'- Canonical label: "{concept.canonical_label}"',
        f"- Slug: {concept.slug}",
        f"- Description: {concept.description}",
        "",
        "# Evidence anchors",
        "",
        "Claim-level anchors from source documents. Cite each via a",
        "footnote when making the corresponding claim.",
        "",
    ]
    for i, ac in enumerate(anchors, 1):
        parts.append(
            f"[a{i}] {ac.doc.file_path} "
            f"({ac.doc.title or 'untitled'} — {ac.doc.author or 'unknown'}, "
            f"{ac.doc.date or 'n.d.'})"
        )
        parts.append(f"  claim: {ac.anchor.claim}")
        parts.append(f"  quote: {ac.anchor.quote}")
        parts.append("")

    parts.append("# Supporting source documents (full text, budgeted)")
    parts.append("")
    parts.append(
        "Each contributing source's full text for context beyond the"
        " anchor quotes. Cite via footnotes when referencing."
    )
    parts.append("")
    for doc in supporting_docs:
        parts.append(
            f"## {doc.file_path}  "
            f"({doc.title or 'untitled'} — {doc.author or 'unknown'}, "
            f"{doc.date or 'n.d.'})"
        )
        parts.append("")
        parts.append(doc.body)
        parts.append("")
        parts.append("---")
        parts.append("")

    parts.append("# Wiki concept registry (link vocabulary)")
    parts.append("")
    parts.append(
        "Other wiki concepts you may link to via "
        "[display text](wiki/slug.md). Only link to concepts in this list."
    )
    parts.append("")
    for c in concept_registry:
        parts.append(
            f"- [{c.canonical_label}](wiki/{c.slug}.md) — {c.kind}: {c.description}"
        )
    parts.append("")

    return "\n".join(parts)


# --- Budgeting --------------------------------------------------------------


def _apply_char_budget(
    docs: list[DocContext], total_budget: int, min_per_doc: int
) -> list[DocContext]:
    """Truncate each doc's body to fit within total_budget.

    Per-doc allowance = max(min_per_doc, total_budget // len(docs)).
    If cumulative allowances exceed total_budget, later docs are dropped
    rather than truncated below min_per_doc.
    """
    if not docs:
        return []
    per_doc = max(min_per_doc, total_budget // len(docs))
    remaining = total_budget
    out: list[DocContext] = []
    for doc in docs:
        if remaining < min_per_doc:
            break
        allowance = min(per_doc, remaining)
        truncated_body = doc.body[:allowance] if len(doc.body) > allowance else doc.body
        out.append(
            DocContext(
                document_id=doc.document_id,
                file_path=doc.file_path,
                title=doc.title,
                author=doc.author,
                date=doc.date,
                body=truncated_body,
            )
        )
        remaining -= len(truncated_body)
    return out


# --- File IO ----------------------------------------------------------------


def _compile_dir(brain_id: uuid.UUID) -> Path:
    return Path(".compile") / str(brain_id)


def _load_concepts(brain_id: uuid.UUID) -> list[Concept]:
    path = _compile_dir(brain_id) / "subjects.jsonl"
    with path.open("r", encoding="utf-8") as f:
        return [Concept(**json.loads(line)) for line in f if line.strip()]


def _load_source_cards(brain_id: uuid.UUID) -> list[SourceCard]:
    path = _compile_dir(brain_id) / "source_cards.jsonl"
    with path.open("r", encoding="utf-8") as f:
        return [SourceCard(**json.loads(line)) for line in f if line.strip()]


def _build_doc_contexts(
    brain_id: uuid.UUID, raw_dir: Path, raw_link_prefix: str
) -> dict[uuid.UUID, DocContext]:
    """Scan raw_dir and build document_id → DocContext lookup.

    document_id is derived deterministically from (brain_id, file_path),
    matching how the extractor generated them. raw_link_prefix overrides
    the file_path stored in DocContext so that footnote links in rendered
    articles use a canonical relative path (e.g. raw/texts/foo.md) even
    if the prototype's raw_dir is elsewhere.
    """
    contexts: dict[uuid.UUID, DocContext] = {}
    for raw_file in sorted(raw_dir.rglob("*.md")):
        doc_id = document_id_for(brain_id, raw_file.as_posix())
        content = raw_file.read_text(encoding="utf-8")
        fm, body = parse_frontmatter(content)
        rel = raw_file.relative_to(raw_dir).as_posix()
        contexts[doc_id] = DocContext(
            document_id=doc_id,
            file_path=f"{raw_link_prefix.rstrip('/')}/{rel}",
            title=fm.get("title") or "",
            author=fm.get("author") or "",
            date=str(fm.get("date") or ""),
            body=body,
        )
    return contexts


def _build_idea_anchor_lookup(
    cards: list[SourceCard], doc_contexts: dict[uuid.UUID, DocContext]
) -> dict[uuid.UUID, list[AnchorWithContext]]:
    """Map each Idea's id to its anchors, resolved against doc contexts.

    Anchors now live inside Ideas on SourceCard, so the lookup is keyed
    by idea_id: Phase 3 gathers a Concept's anchors by walking its
    member_idea_ids through this map.
    """
    lookup: dict[uuid.UUID, list[AnchorWithContext]] = {}
    for card in cards:
        doc = doc_contexts.get(card.document_id)
        if doc is None:
            continue
        for idea in card.ideas:
            lookup[idea.idea_id] = [
                AnchorWithContext(anchor=anchor, doc=doc) for anchor in idea.anchors
            ]
    return lookup


def _write_article_file(*, wiki_dir: Path, concept: Concept, body: str) -> Path:
    """Write the article with minimal user-facing frontmatter.

    Pipeline state (article_status, rendered_from_hash) lives on
    ConceptORM, not here. Archive lineage (supersedes, superseded_by)
    is written only to archived articles' frontmatter by the M7 flow.
    """
    fm = {
        "concept_id": str(concept.concept_id),
        "kind": str(concept.kind),
        "canonical_label": concept.canonical_label,
        "description": concept.description,
    }
    content = serialize_frontmatter(fm, "\n" + body + "\n")
    wiki_dir.mkdir(parents=True, exist_ok=True)
    path = wiki_dir / f"{concept.slug}.md"
    path.write_text(content, encoding="utf-8")
    return path
