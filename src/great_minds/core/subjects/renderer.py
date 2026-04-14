"""Article rendering service.

For each WikiSubject, assemble an evidence pack + supporting doc excerpts
+ subject registry, call the writer LLM, and write a markdown article
with YAML frontmatter to wiki/<slug>.md.

The writer gets three kinds of input:
- Evidence anchors (claim + quote) resolved from subject.evidence_anchor_ids
- Full text of each supporting document, budgeted
- The full subject registry for cross-linking (works up to ~1000 subjects)

Links are standard markdown `[label](wiki/slug.md)`. Citations are doc-
level via markdown footnotes.
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
    ArticleStatus,
    SourceAnchor,
    SourceCard,
    WikiSubject,
)
from great_minds.core.subjects.service import document_id_for
from great_minds.core.telemetry import log_event

MAX_SOURCE_CHARS = 30_000
MIN_PER_SOURCE_CHARS = 4_000
WRITER_MAX_TOKENS = 6000
WRITER_VERSION = 1

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
    subjects = _load_subjects(brain_id)
    cards = _load_source_cards(brain_id)
    doc_contexts = _build_doc_contexts(brain_id, raw_dir, raw_link_prefix)
    anchor_lookup = _build_anchor_lookup(cards, doc_contexts)

    selected = subjects
    if only_multi_doc:
        selected = [s for s in selected if len(s.supporting_document_ids) > 1]
    if limit is not None:
        selected = selected[:limit]

    print(
        f"Rendering {len(selected)} subject(s) of {len(subjects)} "
        f"(only_multi_doc={only_multi_doc}, concurrency={concurrency})"
    )

    sem = asyncio.Semaphore(concurrency)
    tasks = [
        _render_one(client, sem, subject, subjects, anchor_lookup, doc_contexts, wiki_dir)
        for subject in selected
    ]
    outcomes = await asyncio.gather(*tasks)
    return [p for p in outcomes if isinstance(p, Path)]


# --- Core render step --------------------------------------------------------


async def _render_one(
    client: AsyncOpenAI,
    sem: asyncio.Semaphore,
    subject: WikiSubject,
    all_subjects: list[WikiSubject],
    anchor_lookup: dict[uuid.UUID, AnchorWithContext],
    doc_contexts: dict[uuid.UUID, DocContext],
    wiki_dir: Path,
) -> Path | Exception:
    async with sem:
        try:
            anchors = [
                anchor_lookup[aid]
                for aid in subject.evidence_anchor_ids
                if aid in anchor_lookup
            ]
            supporting_docs = [
                doc_contexts[did]
                for did in subject.supporting_document_ids
                if did in doc_contexts
            ]
            supporting_docs = _apply_char_budget(
                supporting_docs, MAX_SOURCE_CHARS, MIN_PER_SOURCE_CHARS
            )
            registry = [s for s in all_subjects if s.subject_id != subject.subject_id]

            body = await _call_writer(
                client,
                subject=subject,
                anchors=anchors,
                supporting_docs=supporting_docs,
                subject_registry=registry,
            )
            path = _write_article_file(wiki_dir=wiki_dir, subject=subject, body=body)
            log_event(
                "article_rendered",
                subject_id=str(subject.subject_id),
                slug=subject.slug,
                supporting_docs=len(supporting_docs),
                anchors=len(anchors),
                output_chars=len(body),
            )
            print(
                f"  {subject.slug}.md  OK  "
                f"{len(supporting_docs)} docs, {len(anchors)} anchors, "
                f"{len(body)} chars",
                flush=True,
            )
            return path
        except Exception as e:
            log_event(
                "article_render_failed",
                level=40,
                subject_id=str(subject.subject_id),
                slug=subject.slug,
                error=str(e)[:300],
            )
            print(
                f"  {subject.slug}.md  FAIL  {type(e).__name__}: {e}",
                flush=True,
            )
            return e


async def _call_writer(
    client: AsyncOpenAI,
    *,
    subject: WikiSubject,
    anchors: list[AnchorWithContext],
    supporting_docs: list[DocContext],
    subject_registry: list[WikiSubject],
) -> str:
    system_prompt = _PROMPT_PATH.read_text(encoding="utf-8")
    user_content = _build_user_content(
        subject=subject,
        anchors=anchors,
        supporting_docs=supporting_docs,
        subject_registry=subject_registry,
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
        raise RuntimeError(f"empty writer response for {subject.subject_id}")
    return text.strip()


# --- User-message assembly --------------------------------------------------


def _build_user_content(
    *,
    subject: WikiSubject,
    anchors: list[AnchorWithContext],
    supporting_docs: list[DocContext],
    subject_registry: list[WikiSubject],
) -> str:
    parts = [
        "# Subject",
        "",
        f"- Kind: {subject.kind}",
        f"- Canonical label: \"{subject.canonical_label}\"",
        f"- Slug: {subject.slug}",
        f"- Scope: {subject.scope_note}",
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

    parts.append("# Wiki subject registry (link vocabulary)")
    parts.append("")
    parts.append(
        "Other wiki subjects you may link to via "
        "[display text](wiki/slug.md). Only link to subjects in this list."
    )
    parts.append("")
    for s in subject_registry:
        parts.append(f"- [{s.canonical_label}](wiki/{s.slug}.md) — {s.kind}: {s.scope_note}")
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


def _load_subjects(brain_id: uuid.UUID) -> list[WikiSubject]:
    path = _compile_dir(brain_id) / "subjects.jsonl"
    with path.open("r", encoding="utf-8") as f:
        return [WikiSubject(**json.loads(line)) for line in f if line.strip()]


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
    for raw_file in sorted(raw_dir.glob("*.md")):
        doc_id = document_id_for(brain_id, raw_file.as_posix())
        content = raw_file.read_text(encoding="utf-8")
        fm, body = parse_frontmatter(content)
        contexts[doc_id] = DocContext(
            document_id=doc_id,
            file_path=f"{raw_link_prefix.rstrip('/')}/{raw_file.name}",
            title=fm.get("title") or "",
            author=fm.get("author") or "",
            date=str(fm.get("date") or ""),
            body=body,
        )
    return contexts


def _build_anchor_lookup(
    cards: list[SourceCard], doc_contexts: dict[uuid.UUID, DocContext]
) -> dict[uuid.UUID, AnchorWithContext]:
    lookup: dict[uuid.UUID, AnchorWithContext] = {}
    for card in cards:
        doc = doc_contexts.get(card.document_id)
        if doc is None:
            continue
        for anchor in card.anchors:
            lookup[anchor.anchor_id] = AnchorWithContext(anchor=anchor, doc=doc)
    return lookup


def _write_article_file(
    *, wiki_dir: Path, subject: WikiSubject, body: str
) -> Path:
    fm = {
        "subject_id": str(subject.subject_id),
        "kind": str(subject.kind),
        "slug": subject.slug,
        "canonical_label": subject.canonical_label,
        "article_status": str(ArticleStatus.RENDERED),
        "writer_version": WRITER_VERSION,
    }
    content = serialize_frontmatter(fm, "\n" + body + "\n")
    wiki_dir.mkdir(parents=True, exist_ok=True)
    path = wiki_dir / f"{subject.slug}.md"
    path.write_text(content, encoding="utf-8")
    return path
