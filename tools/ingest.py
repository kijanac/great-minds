"""Generic ingestion: add frontmatter to documents and write to raw/.

Reads config.yaml for the metadata field list per content type.
Fills programmatic fields (date, source, compiled) from arguments.
Leaves AI fields empty — compilation fills them.

Provides both a library function (for use by source-specific crawl scripts)
and a CLI for ingesting individual files or directories.

Usage:
    # Ingest a single file
    uv run python tools/ingest.py texts paper.md --author "V.I. Lenin" --date 1916

    # Ingest a directory (batch)
    uv run python tools/ingest.py texts corpus/lenin/ --author "V.I. Lenin" --dest raw/texts/lenin/

    # From another script
    from tools.ingest import ingest_document
    ingest_document(content, "texts", author="V.I. Lenin", date=1916, source="https://...")
"""

import argparse
import logging
import re
from io import StringIO
from pathlib import Path

from ruamel.yaml import YAML

log = logging.getLogger(__name__)

CONFIG_PATH = Path("config.yaml")

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


def load_fields(content_type: str) -> list[str]:
    """Load the metadata field list for a content type from config.yaml."""
    if not CONFIG_PATH.exists():
        raise FileNotFoundError(f"Config not found: {CONFIG_PATH}")

    yaml = YAML()
    config = yaml.load(CONFIG_PATH.read_text(encoding="utf-8"))
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
    content: str,
    content_type: str,
    *,
    title: str | None = None,
    author: str | None = None,
    date: int | str | None = None,
    source: str | None = None,
    outlet: str | None = None,
    dest: Path | None = None,
) -> str:
    """Add frontmatter to a document and return the result.

    Args:
        content: Raw markdown content (no frontmatter).
        content_type: One of the types in config.yaml (texts, news, ideas).
        title: Document title. Auto-extracted from headings if not provided.
        author: Author name.
        date: Publication date (year or full date).
        source: Source URL or path.
        outlet: News outlet (for news type).
        dest: If provided, write the result to this path.

    Returns:
        The document content with frontmatter prepended.
    """
    fields = load_fields(content_type)

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
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(result, encoding="utf-8")

    return result


def ingest_file(
    filepath: Path,
    content_type: str,
    dest_dir: Path,
    **kwargs,
) -> Path:
    """Ingest a single file: read, add frontmatter, write to dest."""
    content = filepath.read_text(encoding="utf-8")
    dest = dest_dir / filepath.name
    ingest_document(content, content_type, dest=dest, **kwargs)
    return dest


def ingest_directory(
    source_dir: Path,
    content_type: str,
    dest_dir: Path,
    skip_fn=None,
    **kwargs,
) -> tuple[int, int]:
    """Ingest all .md files from a directory. Returns (processed, skipped)."""
    processed = 0
    skipped = 0

    for filepath in sorted(source_dir.rglob("*.md")):
        if skip_fn and skip_fn(filepath):
            skipped += 1
            continue

        relative = filepath.relative_to(source_dir)
        dest = dest_dir / relative
        content = filepath.read_text(encoding="utf-8")

        ingest_document(content, content_type, dest=dest, **kwargs)
        processed += 1

    return processed, skipped


def main():
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )

    parser = argparse.ArgumentParser(
        description="Ingest documents into the knowledge base"
    )
    parser.add_argument("content_type", help="Content type (texts, news, ideas)")
    parser.add_argument("path", type=Path, help="File or directory to ingest")
    parser.add_argument("--dest", type=Path, help="Destination directory (default: raw/<type>/)")
    parser.add_argument("--author", help="Author name")
    parser.add_argument("--date", help="Publication date")
    parser.add_argument("--source", help="Source URL")
    parser.add_argument("--outlet", help="News outlet (for news type)")
    args = parser.parse_args()

    dest = args.dest or Path(f"raw/{args.content_type}")

    kwargs = {}
    if args.author:
        kwargs["author"] = args.author
    if args.date:
        kwargs["date"] = args.date
    if args.source:
        kwargs["source"] = args.source
    if args.outlet:
        kwargs["outlet"] = args.outlet

    if args.path.is_file():
        result = ingest_file(args.path, args.content_type, dest, **kwargs)
        log.info("ingested %s → %s", args.path, result)
    elif args.path.is_dir():
        processed, skipped = ingest_directory(
            args.path, args.content_type, dest, **kwargs
        )
        log.info("done — %d files ingested to %s/, %d skipped", processed, dest, skipped)
    else:
        log.error("path not found: %s", args.path)


if __name__ == "__main__":
    main()
