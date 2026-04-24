"""Single source of truth for the brain's on-disk hierarchy.

Brain content lives under ``<data_dir>/brains/<brain_id>/`` (or, for
R2 storage, under ``<bucket>/brains/<brain_id>/``)::

    config.yaml                     user config
    prompts/<name>.md               optional prompt overrides
    raw/<content_type>/<path>.md    ingested source files
    wiki/<slug>.md                  rendered articles
    wiki/_index.md                  wiki index
    raw/_index.md                   raw index

Compile sidecar is always machine-local, regardless of storage backend
— it's build-cache state (think ``node_modules/``), regeneratable from
content-hash inputs. It lives under ``<data_dir>/.compile/<brain_id>/``::

    cache/<phase>/<key>.json        per-phase content-hash cache
    source_cards.jsonl              extract output stream
    log.md                          human-readable compile timeline

Package-bundled defaults (``default_config.yaml``, ``default_prompts/``)
ship with the installed package under ``great_minds/core/`` and serve
as fallbacks when a brain hasn't authored an override.

Three helper families:

- **Storage-relative** (``str``): for ``Storage.read/write/glob`` calls.
  Work identically against LocalStorage and R2Storage.
- **Filesystem-absolute** (``Path``): for raw ``Path`` I/O on the compile
  sidecar, which never flows through Storage.
- **Package-resource** (``Path``): shipped-with-the-code defaults. Read
  directly; never written.
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
# Compile sidecar (filesystem-absolute, machine-local)
# ---------------------------------------------------------------------------

COMPILE_DIR = ".compile"


def sidecar_root(data_dir: Path, brain_id: UUID | str) -> Path:
    """Absolute path to a brain's compile sidecar on local disk."""
    return Path(data_dir) / COMPILE_DIR / str(brain_id)


def cache_root(sidecar: Path) -> Path:
    return sidecar / "cache"


def source_cards_path(sidecar: Path) -> Path:
    return sidecar / "source_cards.jsonl"


def compile_log_path(sidecar: Path) -> Path:
    return sidecar / "log.md"


# ---------------------------------------------------------------------------
# Package-bundled defaults (read-only, shipped with the installed package)
# ---------------------------------------------------------------------------

PACKAGE_DIR = Path(__file__).resolve().parent  # great_minds/core/
DEFAULT_CONFIG_PATH = PACKAGE_DIR / "default_config.yaml"
DEFAULT_PROMPTS_DIR = PACKAGE_DIR / "default_prompts"


def default_prompt_path(name: str) -> Path:
    return DEFAULT_PROMPTS_DIR / f"{name}.md"
