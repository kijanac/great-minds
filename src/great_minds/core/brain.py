"""Brain: the central API for a knowledge base instance.

A Brain wraps a storage backend and config, providing compile/query/ingest/lint
operations. All interfaces (CLI, web, Telegram) create a Brain and call its methods.

    from great_minds import Brain, LocalStorage

    brain = Brain(LocalStorage("."), label="my-brain")
    await brain.compile(limit=50)
    answer = brain.query("What is imperialism?")
"""

import logging
from pathlib import Path

from ruamel.yaml import YAML

from . import compiler, ingester, linter, querier
from .storage import Storage

__all__ = ["Brain"]

log = logging.getLogger(__name__)

_PACKAGE_DIR = Path(__file__).resolve().parent


class Brain:
    """A knowledge base instance backed by a Storage implementation."""

    def __init__(self, storage: Storage, *, label: str, config: dict | None = None) -> None:
        self.storage = storage
        self.label = label
        self.config = config if config is not None else self._load_config()

    def _load_config(self) -> dict:
        content = self.storage.read("config.yaml", default=None)
        if content is None:
            return {}
        yaml = YAML()
        raw = yaml.load(content)
        return dict(raw) if raw else {}

    def load_prompt(self, name: str) -> str:
        """Load a prompt template, checking brain overrides first.

        Resolution order:
          1. prompts/{name}.md in the brain's storage
          2. default_prompts/{name}.md shipped with the package
        """
        brain_path = f"prompts/{name}.md"
        content = self.storage.read(brain_path, default=None)
        if content is not None:
            return content.strip()

        default_path = _PACKAGE_DIR / "default_prompts" / f"{name}.md"
        if default_path.exists():
            return default_path.read_text(encoding="utf-8").strip()

        raise FileNotFoundError(
            f"Prompt '{name}' not found in brain storage or package defaults"
        )

    # ------------------------------------------------------------------
    # Operations
    # ------------------------------------------------------------------

    async def compile(self, *, limit: int | None = None) -> "compiler.CompilationResult":
        return await compiler.run(self.storage, self.load_prompt, limit=limit)

    def query(self, question: str, *, model: str | None = None, brains: "list[Brain] | None" = None) -> str:
        return querier.run_query(brains or [self], question, model=model)

    def query_interactive(self, *, model: str | None = None, brains: "list[Brain] | None" = None) -> None:
        querier.run_interactive(brains or [self], model=model)

    def ingest_document(
        self,
        content: str,
        content_type: str,
        *,
        dest: str | None = None,
        **kwargs,
    ) -> str:
        return ingester.ingest_document(
            self.storage, self.config, content, content_type, dest=dest, **kwargs
        )

    def ingest_file(
        self,
        filepath: Path,
        content_type: str,
        dest_dir: str,
        **kwargs,
    ) -> str:
        return ingester.ingest_file(
            self.storage, self.config, filepath, content_type, dest_dir, **kwargs
        )

    def ingest_directory(
        self,
        source_dir: Path,
        content_type: str,
        dest_dir: str,
        skip_fn=None,
        **kwargs,
    ) -> tuple[int, int]:
        return ingester.ingest_directory(
            self.storage, self.config, source_dir, content_type, dest_dir,
            skip_fn=skip_fn, **kwargs,
        )

    def lint(self, *, deep: bool = False) -> int:
        return linter.run_lint(self.storage, deep=deep)
