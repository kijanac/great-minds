"""Single source of truth for the brain's on-disk hierarchy.

Layout under ``<data_dir>/brains/<brain_id>/``::

    config.yaml                     user config
    prompts/<name>.md               optional prompt overrides
    raw/<content_type>/<path>.md    ingested source files
    wiki/<slug>.md                  rendered articles
    wiki/_index.md                  wiki index
    raw/_index.md                   raw index
    .compile/                       compile sidecar (machine-local)
      cache/<phase>/<key>.json      per-phase content-hash cache
      source_cards.jsonl            extract output stream
      log.md                        human-readable compile timeline

Two helper families:

- **Storage-relative** (``str``): for ``Storage.read/write/glob`` calls.
- **Filesystem-absolute** (``Path``): for raw ``Path`` I/O on the compile
  sidecar, whose files don't flow through Storage.
"""

from __future__ import annotations

from pathlib import Path
from uuid import UUID

# ---------------------------------------------------------------------------
# Data-dir-relative: brain root
# ---------------------------------------------------------------------------

BRAINS_DIR = "brains"


def brain_dir(data_dir: Path, brain_id: UUID | str) -> Path:
    """Absolute path to a brain's root directory on disk."""
    return Path(data_dir) / BRAINS_DIR / str(brain_id)


# ---------------------------------------------------------------------------
# Storage-relative subtree paths
# ---------------------------------------------------------------------------

RAW_PREFIX = "raw/"
WIKI_PREFIX = "wiki/"
WIKI_GLOB = "wiki/*.md"
RAW_GLOB = "raw/**/*.md"
WIKI_INDEX_PATH = "wiki/_index.md"
RAW_INDEX_PATH = "raw/_index.md"
CONFIG_PATH = "config.yaml"
PROMPTS_DIR = "prompts"

# Top-level brain content subdirs that the reset command clears.
BRAIN_SUBDIRS: tuple[str, ...] = ("raw", "wiki")


def wiki_path(slug: str) -> str:
    return f"{WIKI_PREFIX}{slug}.md"


def wiki_slug(path: str) -> str:
    return path.removeprefix(WIKI_PREFIX).removesuffix(".md")


def raw_prefix(content_type: str) -> str:
    """Storage-relative directory for a content type's raw files."""
    return f"{RAW_PREFIX}{content_type}"


def raw_path(content_type: str, rel: str) -> str:
    """Full storage-relative path to a raw file of a given type."""
    return f"{RAW_PREFIX}{content_type}/{rel}"


def prompts_path(name: str) -> str:
    return f"{PROMPTS_DIR}/{name}.md"


# ---------------------------------------------------------------------------
# Compile sidecar (filesystem-absolute, rooted at brain_root)
# ---------------------------------------------------------------------------

COMPILE_DIR = ".compile"


def compile_root(brain_root_path: Path) -> Path:
    return brain_root_path / COMPILE_DIR


def cache_root(brain_root_path: Path) -> Path:
    return compile_root(brain_root_path) / "cache"


def source_cards_path(brain_root_path: Path) -> Path:
    return compile_root(brain_root_path) / "source_cards.jsonl"


def compile_log_path(brain_root_path: Path) -> Path:
    return compile_root(brain_root_path) / "log.md"
