"""Brain utilities: config loading, prompt resolution, and wiki helpers.

These functions operate on a Storage backend and are used by both the API
layer (via FastAPI dependencies) and the CLI.
"""

from pathlib import Path

from ruamel.yaml import YAML

from great_minds.core.storage import Storage

_PACKAGE_DIR = Path(__file__).resolve().parent


def load_config(storage: Storage) -> dict:
    """Load brain config from storage, returning empty dict if absent."""
    content = storage.read("config.yaml", strict=False)
    if content is None:
        return {}
    yaml = YAML()
    raw = yaml.load(content)
    return dict(raw) if raw else {}


def load_prompt(storage: Storage, name: str) -> str:
    """Load a prompt template, checking brain overrides first.

    Resolution order:
      1. prompts/{name}.md in the brain's storage
      2. default_prompts/{name}.md shipped with the package
    """
    brain_path = f"prompts/{name}.md"
    content = storage.read(brain_path, strict=False)
    if content is not None:
        return content.strip()

    default_path = _PACKAGE_DIR / "default_prompts" / f"{name}.md"
    if default_path.exists():
        return default_path.read_text(encoding="utf-8").strip()

    raise FileNotFoundError(
        f"Prompt '{name}' not found in brain storage or package defaults"
    )


def wiki_path(slug: str) -> str:
    return f"wiki/{slug}.md"


def wiki_slug(path: str) -> str:
    return path.removeprefix("wiki/").removesuffix(".md")


def list_articles(storage: Storage) -> list[str]:
    """Return wiki article slugs (excluding internal files like _index)."""
    paths = storage.glob("wiki/*.md")
    return [wiki_slug(p) for p in paths if not p.startswith("wiki/_")]


def read_article(storage: Storage, slug: str) -> str | None:
    """Read a single wiki article by slug, or None if missing."""
    return storage.read(wiki_path(slug), strict=False)


def read_index(storage: Storage) -> str:
    """Read the wiki index file."""
    return storage.read("wiki/_index.md", strict=False) or ""
