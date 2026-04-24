"""Content-hash disk cache for per-phase LLM outputs.

One JSON file per (phase, key) under ``<brain_root>/.compile/cache/<phase>/<key>.json``.
Keys are content hashes (phase-specific): extract uses sha256 over
(doc_content + prompt_hash + kinds_config + extract_model); map uses
sha256 over sorted idea_ids in chunk; etc.

The cache is schema-agnostic — callers serialize pydantic models to
dicts and parse them back. This keeps the cache file independent of
model evolution; if a schema changes in a backward-incompatible way,
the prompt_hash (or a similar key component) should change too so old
caches invalidate.

Cache is semantics for incremental compile: a hit defines the
authoritative recording of the LLM's output for that input. On miss,
the caller must actually draw fresh from the LLM and record.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from great_minds.core.paths import cache_root


@dataclass
class ContentHashCache:
    root: Path  # <brain_root>/.compile/cache/

    @classmethod
    def for_brain(cls, brain_root: Path) -> "ContentHashCache":
        return cls(cache_root(brain_root))

    def _path(self, phase: str, key: str) -> Path:
        return self.root / phase / f"{key}.json"

    def get(self, phase: str, key: str) -> dict | None:
        path = self._path(phase, key)
        if not path.exists():
            return None
        return json.loads(path.read_text(encoding="utf-8"))

    def put(self, phase: str, key: str, value: dict) -> None:
        path = self._path(phase, key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value), encoding="utf-8")

    def has(self, phase: str, key: str) -> bool:
        return self._path(phase, key).exists()
