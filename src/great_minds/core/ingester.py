"""Generic ingestion: add frontmatter to documents and write to brain storage.

Reads config for the metadata field list per content type.
Fills programmatic fields (date, source, compiled) from arguments.
Leaves AI fields empty -- compilation fills them.

This module reads from the EXTERNAL filesystem (source corpus) and writes
TO brain storage. It is always called via a Brain instance:

    brain.ingest_document(content, "texts", author="V.I. Lenin", date=1916)
    brain.ingest_file(Path("corpus/lenin/ch1.md"), "texts", "raw/texts/lenin/")
"""


import logging
import re
from io import StringIO
from pathlib import Path

from ruamel.yaml import YAML

from .storage import Storage

log = logging.getLogger(__name__)

_yaml = YAML()
_yaml.default_flow_style = False

# Default empty values by type
_FIELD_DEFAULTS = {
    "compiled": False,
    "notes": "",
}

# Fields that take list values
_LIST_FIELDS = {"interlocutors", "concepts", "tags", "topic_tags"}

# Fields that take string values
_STRING_FIELDS = {"author", "source", "genre", "tradition", "outlet", "relevance", "status"}


def load_fields(storage: Storage, config: dict, content_type: str) -> list[str]:
    """Load the metadata field list for a content type from brain config."""
    metadata = config.get("metadata", {})

    if content_type not in metadata:
        raise ValueError(
            f"Unknown content type '{content_type}'. "
            f"Available: {list(metadata.keys())}"
        )

    return list(metadata[content_type])


def build_frontmatter(fields: list[str], known: dict) -> str:
    """Build YAML frontmatter from a field list and known values.

    Fields present in `known` get their value. Fields not in `known`
    get a type-appropriate default (empty string, empty list, or False).
    """
    fm = {}
    for field in fields:
        if field in known:
            fm[field] = known[field]
        elif field in _FIELD_DEFAULTS:
            fm[field] = _FIELD_DEFAULTS[field]
        elif field in _LIST_FIELDS:
            fm[field] = []
        elif field == "date":
            fm[field] = ""
        else:
            fm[field] = ""

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


def ingest_document(
    storage: Storage, config: dict,
    content: str,
    content_type: str,
    *,
    title: str | None = None,
    author: str | None = None,
    date: int | str | None = None,
    source: str | None = None,
    outlet: str | None = None,
    dest: str | None = None,
) -> str:
    """Add frontmatter to a document and return the result.

    Args:
        storage: Storage, config: dict instance providing config and storage.
        content: Raw markdown content (no frontmatter).
        content_type: One of the types in config metadata (texts, news, ideas).
        title: Document title. Auto-extracted from headings if not provided.
        author: Author name.
        date: Publication date (year or full date).
        source: Source URL or path.
        outlet: News outlet (for news type).
        dest: If provided, a path relative to brain root; written via storage.

    Returns:
        The document content with frontmatter prepended.
    """
    fields = load_fields(storage, config, content_type)

    # Build known values from arguments
    known: dict = {"compiled": False}

    if title or "title" in fields:
        known["title"] = title or extract_title(content) or ""
    if author:
        known["author"] = author
    if date is not None:
        known["date"] = date
    if source:
        known["source"] = source
    if outlet:
        known["outlet"] = outlet

    frontmatter = build_frontmatter(fields, known)
    result = frontmatter + content

    if dest:
        storage.write(dest, result)

    return result


def ingest_file(
    storage: Storage, config: dict,
    filepath: Path,
    content_type: str,
    dest_dir: str,
    **kwargs,
) -> str:
    """Ingest a single file: read from filesystem, add frontmatter, write to brain storage.

    Args:
        storage: Storage, config: dict instance providing config and storage.
        filepath: Path on the external filesystem (the source file being ingested).
        content_type: One of the types in config metadata.
        dest_dir: Destination directory relative to brain root (e.g. "raw/texts/lenin/").
        **kwargs: Passed through to ingest_document (author, date, source, etc.).

    Returns:
        The dest path string (relative to brain root).
    """
    content = filepath.read_text(encoding="utf-8")
    dest = f"{dest_dir}/{filepath.name}"
    ingest_document(storage, config, content, content_type, dest=dest, **kwargs)
    return dest


def ingest_directory(
    storage: Storage, config: dict,
    source_dir: Path,
    content_type: str,
    dest_dir: str,
    skip_fn=None,
    **kwargs,
) -> tuple[int, int]:
    """Ingest all .md files from a directory. Returns (processed, skipped).

    Args:
        storage: Storage, config: dict instance providing config and storage.
        source_dir: Directory on the external filesystem to read from.
        content_type: One of the types in config metadata.
        dest_dir: Destination directory relative to brain root.
        skip_fn: Optional callable; if it returns True for a filepath, skip it.
        **kwargs: Passed through to ingest_document (author, date, source, etc.).

    Returns:
        Tuple of (processed_count, skipped_count).
    """
    processed = 0
    skipped = 0

    for filepath in sorted(source_dir.rglob("*.md")):
        if skip_fn and skip_fn(filepath):
            skipped += 1
            continue

        relative = filepath.relative_to(source_dir)
        dest = f"{dest_dir}/{relative}"
        content = filepath.read_text(encoding="utf-8")

        ingest_document(storage, config, content, content_type, dest=dest, **kwargs)
        processed += 1

    return processed, skipped
