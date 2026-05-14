"""Single source of truth for the vault's on-disk hierarchy.

Vault content lives under ``<data_dir>/vaults/<vault_id>/`` (or, for
R2 storage, under ``<bucket>/vaults/<vault_id>/``)::

    config.yaml                     user config
    prompts/<name>.md               optional prompt overrides
    raw/<source_kind>/<path>.md     ingested source files
    wiki/<slug>.md                  rendered articles
    wiki/_index.md                  wiki index
    raw/_index.md                   raw index

Compile intermediates are split by durability needs. The compile cache is
DB-backed. The extract source-card stream lives in vault storage at
``compile/source_cards.jsonl`` (local in dev, R2 in prod) so background
workers can resume on different machines. The remaining local sidecar is
machine-local scratch state under ``<data_dir>/.compile/<vault_id>/``::

    log.md                          human-readable compile timeline

Package-bundled defaults (``default_config.yaml``, ``default_prompts/``)
ship with the installed package under ``great_minds/core/`` and serve
as fallbacks when a vault hasn't authored an override.

Three helper families:

- **Storage-relative** (``str``): for ``Storage.read/write/glob`` calls.
  Work identically against LocalStorage and R2Storage.
- **Filesystem-absolute** (``Path``): for raw ``Path`` I/O on the compile
  sidecar, which never flows through Storage.
- **Package-resource** (``Path``): shipped-with-the-code defaults. Read
  directly; never written.
"""

from pathlib import Path
from uuid import UUID

# ---------------------------------------------------------------------------
# Data-dir-relative: vault root
# ---------------------------------------------------------------------------

VAULTS_DIR = "vaults"


def vault_dir(data_dir: Path, vault_id: UUID | str) -> Path:
    """Absolute path to a vault's root directory on disk."""
    return Path(data_dir) / VAULTS_DIR / str(vault_id)


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

# Top-level vault content subdirs that the reset command clears.
VAULT_SUBDIRS: tuple[str, ...] = ("raw", "wiki")


def wiki_path(slug: str) -> str:
    return f"{WIKI_PREFIX}{slug}.md"


def wiki_slug(path: str) -> str:
    return path.removeprefix(WIKI_PREFIX).removesuffix(".md")


def raw_prefix(source_kind: str) -> str:
    """Storage-relative directory for a source kind's raw files.

    ``source_kind`` is the on-disk dirname — "docs" for curator-ingested
    documents, "sessions" for promoted exchanges, "user" for anchored
    suggestions. This is independent of the ``source_type`` column
    value (which uses the singular form).
    """
    return f"{RAW_PREFIX}{source_kind}"


def raw_path(source_kind: str, rel: str) -> str:
    """Full storage-relative path to a raw file of a given source kind."""
    return f"{RAW_PREFIX}{source_kind}/{rel}"


def session_exchange_path(exchange_id: str) -> str:
    """Path for a session exchange promoted into the raw corpus."""
    return raw_path("sessions", f"{exchange_id}.md")


def prompts_path(name: str) -> str:
    return f"{PROMPTS_DIR}/{name}.md"


# ---------------------------------------------------------------------------
# Compile sidecar (filesystem-absolute, machine-local)
# ---------------------------------------------------------------------------

COMPILE_DIR = ".compile"


def sidecar_root(data_dir: Path, vault_id: UUID | str) -> Path:
    """Absolute path to a vault's compile sidecar on local disk."""
    return Path(data_dir) / COMPILE_DIR / str(vault_id)


def compile_log_path(sidecar: Path) -> Path:
    return sidecar / "log.md"


# ---------------------------------------------------------------------------
# Proposal staging (filesystem-absolute, machine-local)
# ---------------------------------------------------------------------------

PROPOSALS_DIR = "proposals"


def proposal_staging_path(proposal_id: UUID | str) -> str:
    """Storage-relative path for a staged proposal file."""
    return f"{proposal_id}.md"


# ---------------------------------------------------------------------------
# Package-bundled defaults (read-only, shipped with the installed package)
# ---------------------------------------------------------------------------

PACKAGE_DIR = Path(__file__).resolve().parent  # great_minds/core/
DEFAULT_CONFIG_PATH = PACKAGE_DIR / "default_config.yaml"
DEFAULT_PROMPTS_DIR = PACKAGE_DIR / "default_prompts"


def default_prompt_path(name: str) -> Path:
    return DEFAULT_PROMPTS_DIR / f"{name}.md"
