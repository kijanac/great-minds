"""Phase 5: mechanical wiki index + compile log.

No LLM calls. Composes wiki/index.md by grouping concepts by kind,
listing each as `[canonical_label](slug.md) — description`, and
appends a run summary to .compile/<brain>/log.md.

Tag mirror to a concept_tags junction is explicitly deferred: the
existing agent-SQL tool path (querier.query_documents) hits the
documents table's tag mirror for raw sources; wiki-metadata SQL will
be served by querier.query_concepts against ConceptORM (extension
task in M5 follow-ons). Doc-level tags on concepts can be added as a
concept_tags junction whenever a product need arises.
"""

from __future__ import annotations

import uuid
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

from great_minds.core.subjects.schemas import Concept
from great_minds.core.telemetry import log_event

_KIND_ORDER = [
    "concept",
    "person",
    "organization",
    "movement",
    "event",
    "work",
    "place",
    "other",
]


def write_index(*, wiki_dir: Path, concepts: list[Concept]) -> Path:
    """Write wiki/index.md listing every concept grouped by kind.

    Returns the path written. Overwrites any prior index.
    """
    wiki_dir.mkdir(parents=True, exist_ok=True)
    path = wiki_dir / "index.md"

    by_kind: dict[str, list[Concept]] = defaultdict(list)
    for concept in concepts:
        by_kind[concept.kind.value].append(concept)

    lines: list[str] = ["# Wiki index", ""]
    kinds_present = [k for k in _KIND_ORDER if by_kind.get(k)]
    for k in sorted(by_kind):
        if k not in _KIND_ORDER:
            kinds_present.append(k)

    for kind in kinds_present:
        entries = sorted(by_kind[kind], key=lambda c: c.canonical_label.lower())
        if not entries:
            continue
        lines.append(f"## {kind.capitalize()}")
        lines.append("")
        for c in entries:
            lines.append(f"- [{c.canonical_label}]({c.slug}.md) — {c.description}")
        lines.append("")

    path.write_text("\n".join(lines), encoding="utf-8")
    log_event("wiki_index_written", path=path.as_posix(), concepts=len(concepts))
    return path


def append_log(
    *,
    compile_dir: Path,
    brain_id: uuid.UUID,
    added: list[Concept],
    dirty: list[Concept],
    retired: list[tuple[uuid.UUID, str]],
    articles_rendered: int,
    chunks_indexed: int,
) -> Path:
    """Append a single run entry to .compile/<brain>/log.md.

    Entries are append-only and human-readable. The log is a timeline
    of compile runs — useful for understanding how the registry has
    drifted over time and for debugging unexpected churn.
    """
    compile_dir.mkdir(parents=True, exist_ok=True)
    path = compile_dir / "log.md"
    ts = datetime.now(timezone.utc).isoformat(timespec="seconds")
    entry = [
        f"## {ts} — brain {brain_id}",
        f"- added concepts: {len(added)}",
        f"- dirty concepts: {len(dirty)}",
        f"- retired slugs: {len(retired)}",
        f"- articles rendered: {articles_rendered}",
        f"- chunks indexed: {chunks_indexed}",
    ]
    if added:
        entry.append("- added slugs: " + ", ".join(c.slug for c in added[:20]))
    if retired:
        entry.append("- retired slugs: " + ", ".join(s for _, s in retired[:20]))
    entry.append("")

    existing = path.read_text(encoding="utf-8") if path.exists() else ""
    path.write_text(existing + "\n".join(entry) + "\n", encoding="utf-8")
    return path
