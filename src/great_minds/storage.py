"""Storage abstraction for brain data.

All paths passed to Storage methods are relative to the brain root.
Example: "wiki/imperialism.md", "raw/texts/lenin/works/1893/market/01.md"
"""

from abc import ABC, abstractmethod
from pathlib import Path


class Storage(ABC):
    """Abstract interface for brain file storage."""

    @abstractmethod
    def read(self, path: str) -> str:
        """Read text content from a path relative to the brain root."""

    @abstractmethod
    def write(self, path: str, content: str) -> None:
        """Write text content. Creates parent directories as needed."""

    @abstractmethod
    def exists(self, path: str) -> bool:
        """Check whether a path exists."""

    @abstractmethod
    def glob(self, pattern: str) -> list[str]:
        """Glob for files. Returns sorted relative paths.

        Example: storage.glob("wiki/*.md") -> ["wiki/a.md", "wiki/b.md"]
        """

    @abstractmethod
    def mkdir(self, path: str) -> None:
        """Create a directory (and parents)."""


class LocalStorage(Storage):
    """Storage backed by a local filesystem directory."""

    def __init__(self, root: Path | str) -> None:
        self.root = Path(root).resolve()

    def _resolve(self, path: str) -> Path:
        return self.root / path

    def read(self, path: str) -> str:
        return self._resolve(path).read_text(encoding="utf-8")

    def write(self, path: str, content: str) -> None:
        full = self._resolve(path)
        full.parent.mkdir(parents=True, exist_ok=True)
        full.write_text(content, encoding="utf-8")

    def exists(self, path: str) -> bool:
        return self._resolve(path).exists()

    def glob(self, pattern: str) -> list[str]:
        matches = sorted(self.root.glob(pattern))
        return [str(m.relative_to(self.root)) for m in matches]

    def mkdir(self, path: str) -> None:
        self._resolve(path).mkdir(parents=True, exist_ok=True)
