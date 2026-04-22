"""Per-brain compile-time config.

Each brain has a config.yaml at .compile/<brain_id>/config.yaml that
shapes two LLM surfaces:
  - extract: constrains idea kinds to the declared taxonomy
  - reduce:  prepends thematic_hint to steer canonical topic framing

Both fields have defaults so a brain without config.yaml still compiles.
The frontend edits this file directly (source of truth); Postgres knows
only the brain_id. ruamel.yaml is used so round-trips preserve user
comments and formatting.
"""

from __future__ import annotations

import io
from dataclasses import dataclass
from pathlib import Path
from uuid import UUID

from ruamel.yaml import YAML

DEFAULT_KINDS: tuple[str, ...] = ("person", "event", "organization", "concept")
DEFAULT_THEMATIC_HINT: str = ""

COMPILE_BASE_DIR = Path(".compile")

_yaml = YAML()
_yaml.preserve_quotes = True
_yaml.indent(mapping=2, sequence=4, offset=2)


@dataclass(frozen=True)
class BrainConfig:
    kinds: tuple[str, ...] = DEFAULT_KINDS
    thematic_hint: str = DEFAULT_THEMATIC_HINT


def compile_root(brain_id: UUID, base_dir: Path = COMPILE_BASE_DIR) -> Path:
    return base_dir / str(brain_id)


def config_path(brain_id: UUID, base_dir: Path = COMPILE_BASE_DIR) -> Path:
    return compile_root(brain_id, base_dir) / "config.yaml"


def load_brain_config(
    brain_id: UUID, base_dir: Path = COMPILE_BASE_DIR
) -> BrainConfig:
    path = config_path(brain_id, base_dir)
    if not path.exists():
        return BrainConfig()
    data = _yaml.load(path.read_text(encoding="utf-8")) or {}
    kinds_raw = data.get("kinds")
    kinds = tuple(kinds_raw) if kinds_raw else DEFAULT_KINDS
    thematic_hint = data.get("thematic_hint") or DEFAULT_THEMATIC_HINT
    return BrainConfig(kinds=kinds, thematic_hint=thematic_hint)


def write_brain_config(
    brain_id: UUID,
    config: BrainConfig,
    base_dir: Path = COMPILE_BASE_DIR,
) -> None:
    path = config_path(brain_id, base_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    buf = io.StringIO()
    _yaml.dump(
        {"kinds": list(config.kinds), "thematic_hint": config.thematic_hint},
        buf,
    )
    path.write_text(buf.getvalue(), encoding="utf-8")
