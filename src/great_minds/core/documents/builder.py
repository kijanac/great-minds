"""Build markdown source documents and write them to brain storage.

Pure builders (`build_document`, `build_frontmatter`, `extract_title`)
take config + content + metadata and return the on-disk markdown form.
The write helpers (`write_document`, `write_file`) compose the builders
with storage I/O for callers that have raw bytes/text on hand. DB
indexing happens elsewhere — these functions know nothing about
brain_id or the documents table.

Universal frontmatter fields (title/author/origin/date/url, plus
genre/tags and the structural compiled/source_type flags) are always
emitted. Per-content_type fields come from the brain's config.yaml
``metadata.<content_type>`` section via ``load_field_specs``.

Callers:
    - ``IngestService`` (core/ingest_service.py) — wraps these in
      source-conversion + DB indexing for the API entry points.
    - ``workers.bulk_ingest_task`` — bulk corpus ingest with concurrent
      writes.
    - ``scripts/bulk_ingest_corpus.py`` — local-dev one-shot.
"""

import logging
import re
from dataclasses import dataclass
from io import StringIO
from pathlib import Path
from typing import Literal

from ruamel.yaml import YAML

from great_minds.core.markdown import inject_anchors
from great_minds.core.storage import Storage

log = logging.getLogger(__name__)

_yaml = YAML()
_yaml.default_flow_style = False


# ---------------------------------------------------------------------------
# Universal fields — always present in every document's frontmatter
# ---------------------------------------------------------------------------

UNIVERSAL_PROVIDED = ["title", "author", "origin", "date", "url"]
UNIVERSAL_ENRICHED = ["genre", "tags"]
STRUCTURAL = ["compiled", "source_type"]
UNIVERSAL_ALL = UNIVERSAL_PROVIDED + UNIVERSAL_ENRICHED + STRUCTURAL

_UNIVERSAL_DEFAULTS: dict[str, object] = {
    "title": "",
    "author": "",
    "origin": "",
    "date": "",
    "url": "",
    "genre": "",
    "tags": [],
    "compiled": False,
    "source_type": "document",
}


# ---------------------------------------------------------------------------
# Config-driven field specs
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class FieldSpec:
    """A metadata field definition read from config."""

    name: str
    type: Literal["string", "list"]
    source: Literal["provided", "enriched"]
    description: str = ""
    default: str | list | None = None


def load_field_specs(config: dict, content_type: str) -> list[FieldSpec]:
    """Load config-driven field specs for a content type.

    Universal fields are NOT included — they're handled separately.
    """
    metadata = config.get("metadata", {})

    if content_type not in metadata:
        raise ValueError(
            f"Unknown content type '{content_type}'. Available: {list(metadata.keys())}"
        )

    ct_fields = metadata[content_type]
    specs = []
    for name, defn in ct_fields.items():
        if isinstance(defn, dict):
            specs.append(
                FieldSpec(
                    name=name,
                    type=defn.get("type", "string"),
                    source=defn.get("source", "provided"),
                    description=defn.get("description", ""),
                    default=defn.get("default"),
                )
            )
    return specs


def build_frontmatter(
    field_specs: list[FieldSpec],
    known: dict,
) -> str:
    """Build YAML frontmatter from universal fields + config-driven specs.

    Universal fields are always emitted first, then config-driven fields.
    Values present in `known` are used; others get type-appropriate defaults.
    """
    fm: dict = {}

    for field in UNIVERSAL_ALL:
        if field in known:
            fm[field] = known[field]
        else:
            fm[field] = _UNIVERSAL_DEFAULTS[field]

    for spec in field_specs:
        if spec.name in known:
            fm[spec.name] = known[spec.name]
        elif spec.default is not None:
            fm[spec.name] = spec.default
        elif spec.type == "list":
            fm[spec.name] = []
        else:
            fm[spec.name] = ""

    buf = StringIO()
    _yaml.dump(fm, buf)
    return f"---\n{buf.getvalue()}---\n"


def extract_title(content: str) -> str:
    """Best-effort title extraction from markdown headings."""
    md_link_re = re.compile(r"\[{1,2}[^\]]*\]{1,2}\([^)]*\)")
    for match in re.finditer(r"^#{1,4}\s+(.+)", content, re.MULTILINE):
        title = match.group(1).strip()
        title = md_link_re.sub("", title)
        title = title.replace("_", "").replace("*", "").replace("\\", "")
        title = title.strip()
        if title and len(title) > 3:
            return title
    return ""


def build_document(
    config: dict,
    content: str,
    content_type: str,
    *,
    title: str | None = None,
    author: str | None = None,
    date: str | None = None,
    origin: str | None = None,
    url: str | None = None,
    source_type: str = "document",
    **extra,
) -> str:
    """Prepend frontmatter to raw content. Pure — no I/O.

    The built content is a deterministic function of inputs (config +
    metadata + raw content) and is safe to hash for dedup.
    """
    field_specs = load_field_specs(config, content_type)

    known: dict = {"compiled": False, "source_type": source_type}
    known["title"] = title or extract_title(content) or ""
    if author:
        known["author"] = author
    if date is not None:
        known["date"] = date
    if origin:
        known["origin"] = origin
    if url:
        known["url"] = url

    for spec in field_specs:
        if spec.name in extra:
            known[spec.name] = extra[spec.name]

    frontmatter = build_frontmatter(field_specs, known)
    # Obsidian-style paragraph anchors (`^pN`) get baked into raw
    # content at ingest time. Render's footnote URLs deep-link to them
    # via `raw/.../file.md#^p12`, which works natively in Obsidian and
    # in the web viewer (frontend renders `^pN` as HTML anchors).
    return frontmatter + inject_anchors(content)


async def write_document(
    storage: Storage,
    config: dict,
    content: str,
    content_type: str,
    *,
    dest: str,
    title: str | None = None,
    author: str | None = None,
    date: str | None = None,
    origin: str | None = None,
    url: str | None = None,
    source_type: str = "document",
    **extra,
) -> str:
    """Build a document with frontmatter and persist it to storage."""
    built = build_document(
        config,
        content,
        content_type,
        title=title,
        author=author,
        date=date,
        origin=origin,
        url=url,
        source_type=source_type,
        **extra,
    )
    await storage.write(dest, built)
    return built


async def write_file(
    storage: Storage,
    config: dict,
    filepath: Path,
    content_type: str,
    dest_dir: str,
    **kwargs,
) -> str:
    """Read a file from the external filesystem and write it to brain storage.

    Args:
        storage: Brain storage backend.
        config: Brain config (parsed config.yaml).
        filepath: Path on the external filesystem (the source file).
        content_type: One of the types in ``config['metadata']``.
        dest_dir: Destination directory relative to brain root
            (e.g. ``raw/texts/lenin/``).
        **kwargs: Passed through to ``write_document`` (author, date, etc.).

    Returns:
        The dest path string (relative to brain root).
    """
    content = filepath.read_text(encoding="utf-8")
    dest = f"{dest_dir}/{filepath.name}"
    await write_document(storage, config, content, content_type, dest=dest, **kwargs)
    return dest
