"""Brain utilities: config loading, prompt resolution, and wiki helpers.

These functions operate on a Storage backend and are used by both the API
layer (via FastAPI dependencies) and the CLI.
"""

from ruamel.yaml import YAML

from great_minds.core.paths import (
    CONFIG_PATH,
    DEFAULT_CONFIG_PATH,
    WIKI_GLOB,
    WIKI_INDEX_PATH,
    WIKI_PREFIX,
    default_prompt_path,
    prompts_path,
    wiki_path,
    wiki_slug,
)
from great_minds.core.storage import Storage


def load_config(storage: Storage) -> dict:
    """Load brain config from storage, returning empty dict if absent."""
    content = storage.read(CONFIG_PATH, strict=False)
    if content is None:
        return {}
    yaml = YAML()
    raw = yaml.load(content)
    return dict(raw) if raw else {}


def load_default_config_text() -> str:
    """Read the package-bundled default config.yaml."""
    return DEFAULT_CONFIG_PATH.read_text(encoding="utf-8")


def load_prompt(storage: Storage, name: str) -> str:
    """Load a prompt template, checking brain overrides first.

    Resolution order:
      1. prompts/{name}.md in the brain's storage
      2. default_prompts/{name}.md shipped with the package
    """
    content = storage.read(prompts_path(name), strict=False)
    if content is not None:
        return content.strip()

    default_path = default_prompt_path(name)
    if default_path.exists():
        return default_path.read_text(encoding="utf-8").strip()

    raise FileNotFoundError(
        f"Prompt '{name}' not found in brain storage or package defaults"
    )


def list_articles(storage: Storage) -> list[str]:
    """Return wiki article slugs (excluding internal files like _index)."""
    paths = storage.glob(WIKI_GLOB)
    return [wiki_slug(p) for p in paths if not p.startswith(f"{WIKI_PREFIX}_")]


def read_article(storage: Storage, slug: str) -> str | None:
    """Read a single wiki article by slug, or None if missing."""
    return storage.read(wiki_path(slug), strict=False)


def read_index(storage: Storage) -> str:
    """Read the wiki index file."""
    return storage.read(WIKI_INDEX_PATH, strict=False) or ""
