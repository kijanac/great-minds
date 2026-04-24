"""Per-brain compile-time config.

One config.yaml per brain, at {storage.root}/config.yaml — the same
file the ingest path reads for per-source-type metadata schemas. We
just parse different sections for different purposes.

Shape:

    kinds:
      - person
      - event
      - organization
      - concept

    thematic_hint: |
      Prefer topics shaped like events and intellectual debates.

    metadata:
      texts:
        tradition: {type: string, source: enriched, description: ...}
        interlocutors: {type: list, source: enriched, description: ...}
      news:
        outlet: {type: string, source: provided}
        ...
"""

from __future__ import annotations

from dataclasses import dataclass, field

from ruamel.yaml import YAML

from great_minds.core.paths import CONFIG_PATH
from great_minds.core.storage import Storage

DEFAULT_KINDS: tuple[str, ...] = ("person", "event", "organization", "concept")
DEFAULT_THEMATIC_HINT: str = ""

_yaml = YAML()
_yaml.preserve_quotes = True
_yaml.indent(mapping=2, sequence=4, offset=2)


@dataclass(frozen=True)
class BrainConfig:
    """Parsed view of the compile-relevant sections of config.yaml.

    `raw` preserves the full dict so callers that need other sections
    (ingester's metadata schemas, etc.) can access them without a
    second load.
    """

    kinds: tuple[str, ...] = DEFAULT_KINDS
    thematic_hint: str = DEFAULT_THEMATIC_HINT
    raw: dict = field(default_factory=dict)


def load_brain_config(storage: Storage) -> BrainConfig:
    content = storage.read(CONFIG_PATH, strict=False)
    if content is None:
        return BrainConfig()
    data = _yaml.load(content) or {}
    kinds_raw = data.get("kinds")
    kinds = tuple(kinds_raw) if kinds_raw else DEFAULT_KINDS
    thematic_hint = data.get("thematic_hint") or DEFAULT_THEMATIC_HINT
    return BrainConfig(
        kinds=kinds,
        thematic_hint=thematic_hint,
        raw=dict(data),
    )
