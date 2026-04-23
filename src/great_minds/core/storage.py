"""Storage abstraction for brain data.

All paths passed to Storage methods are relative to the brain root.
Example: "wiki/imperialism.md", "raw/texts/lenin/works/1893/market/01.md"
"""

from pathlib import Path
from typing import Protocol, runtime_checkable


@runtime_checkable
class Storage(Protocol):
    """Structural interface for brain file storage."""

    def read(self, path: str, *, strict: bool = True) -> str | None: ...
    def write(self, path: str, content: str) -> None: ...
    def exists(self, path: str) -> bool: ...
    def glob(self, pattern: str) -> list[str]: ...
    def append(self, path: str, content: str) -> None: ...
    def mkdir(self, path: str) -> None: ...
    def delete(self, path: str, *, missing_ok: bool = True) -> None: ...


class LocalStorage:
    """Storage backed by a local filesystem directory."""

    def __init__(self, root: Path | str) -> None:
        self.root = Path(root).resolve()

    def _resolve(self, path: str) -> Path:
        resolved = (self.root / path).resolve()
        if not resolved.is_relative_to(self.root):
            raise ValueError(f"Path escapes storage root: {path}")
        return resolved

    def read(self, path: str, *, strict: bool = True) -> str | None:
        """Read text content. Returns None if strict=False and path doesn't exist."""
        try:
            return self._resolve(path).read_text(encoding="utf-8")
        except FileNotFoundError:
            if strict:
                raise
            return None

    def write(self, path: str, content: str) -> None:
        full = self._resolve(path)
        full.parent.mkdir(parents=True, exist_ok=True)
        full.write_text(content, encoding="utf-8")

    def exists(self, path: str) -> bool:
        return self._resolve(path).exists()

    def glob(self, pattern: str) -> list[str]:
        matches = sorted(self.root.glob(pattern))
        return [str(m.relative_to(self.root)) for m in matches]

    def append(self, path: str, content: str) -> None:
        full = self._resolve(path)
        full.parent.mkdir(parents=True, exist_ok=True)
        with full.open("a", encoding="utf-8") as f:
            f.write(content)

    def mkdir(self, path: str) -> None:
        self._resolve(path).mkdir(parents=True, exist_ok=True)

    def delete(self, path: str, *, missing_ok: bool = True) -> None:
        self._resolve(path).unlink(missing_ok=missing_ok)
