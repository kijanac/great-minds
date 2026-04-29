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
from io import StringIO

from openai import AsyncOpenAI
from ruamel.yaml import YAML

from great_minds.core.brain import load_default_config_text
from great_minds.core.llm import QUERY_MODEL
from great_minds.core.llm.client import api_call, extract_content
from great_minds.core.paths import CONFIG_PATH
from great_minds.core.storage import Storage

DEFAULT_KINDS: tuple[str, ...] = ("person", "event", "organization", "concept")
DEFAULT_THEMATIC_HINT: str = ""

_yaml = YAML()
_yaml.preserve_quotes = True
_yaml.indent(mapping=2, sequence=4, offset=2)


_DRAFT_HINT_SYSTEM = (
    "You translate a user's free-form description of their knowledge base "
    "into a one-paragraph editorial steer for an LLM that decides how to "
    "frame canonical wiki topics. The steer should describe what kinds of "
    "framings to prefer (e.g. event-centric vs biographical, debate-centric "
    "vs descriptive) given the user's domain. Keep it 2–4 sentences, "
    "concrete, and actionable. Do not include preamble, headings, or "
    "quotation marks — return only the steer text."
)


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


async def load_brain_config(storage: Storage) -> BrainConfig:
    content = await storage.read(CONFIG_PATH, strict=False)
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


async def apply_brain_config_overrides(
    storage: Storage,
    *,
    thematic_hint: str | None = None,
    kinds: list[str] | None = None,
) -> None:
    """Merge overrides into the brain's config.yaml.

    Reads the existing file (or falls back to the package default if
    the brain doesn't have one yet), applies the overrides, and writes
    back. ``None`` for a field means "leave unchanged" — passing the
    empty string clears thematic_hint, passing ``[]`` clears kinds.
    """
    existing = await storage.read(CONFIG_PATH, strict=False)
    if existing is None:
        existing = load_default_config_text()
    data = _yaml.load(existing) or {}
    if thematic_hint is not None:
        data["thematic_hint"] = thematic_hint
    if kinds is not None:
        data["kinds"] = list(kinds)
    buf = StringIO()
    _yaml.dump(data, buf)
    await storage.write(CONFIG_PATH, buf.getvalue())


async def draft_thematic_hint(client: AsyncOpenAI, description: str) -> str:
    """Turn a free-form domain description into a thematic_hint draft."""
    response = await api_call(
        client,
        model=QUERY_MODEL,
        messages=[
            {"role": "system", "content": _DRAFT_HINT_SYSTEM},
            {"role": "user", "content": description.strip()},
        ],
        temperature=0.4,
    )
    return extract_content(response) or ""
