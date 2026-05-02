"""Prompt template loading: brain-storage override → package default fallback."""

from great_minds.core.paths import default_prompt_path, prompts_path
from great_minds.core.storage import Storage


async def load_prompt(storage: Storage, name: str) -> str:
    """Load a prompt template, checking brain overrides first.

    Resolution order:
      1. prompts/{name}.md in the brain's storage
      2. default_prompts/{name}.md shipped with the package
    """
    content = await storage.read(prompts_path(name), strict=False)
    if content is not None:
        return content.strip()

    default_path = default_prompt_path(name)
    if default_path.exists():
        return default_path.read_text(encoding="utf-8").strip()

    raise FileNotFoundError(
        f"Prompt '{name}' not found in brain storage or package defaults"
    )
