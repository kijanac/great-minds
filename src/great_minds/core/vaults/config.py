"""Vault config: storage-backed config.yaml loading and override editing.

One config.yaml per vault at {storage.root}/config.yaml. Shape:

    name: "..."

    kinds:
      - person
      - event
      - organization
      - concept

    thematic_hint: |
      Prefer topics shaped like events and intellectual debates.

    metadata:
      # Vault-configured enriched fields. Each entry declares a field the
      # extract LLM should look for in every document. The LLM's value
      # lands in source_documents.derived_extras (JSONB) and gets
      # surfaced in partition / synthesize editorial context.
      tradition:
        type: string
        description: ...
      interlocutors:
        type: list
        description: ...
"""

from dataclasses import dataclass, field
from io import StringIO
from typing import Literal

from openai import AsyncOpenAI
from ruamel.yaml import YAML

from great_minds.core.llm import QUERY_MODEL
from great_minds.core.llm.client import api_call, extract_content
from great_minds.core.paths import CONFIG_PATH, DEFAULT_CONFIG_PATH
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
class EnrichedFieldSpec:
    """A vault-configured enriched metadata field.

    Declares a key the extract LLM should look for in every document.
    ``type`` constrains the JSON shape returned ("string" or list of
    strings); ``description`` is rendered into the extract prompt to
    guide what the LLM should fill in.
    """

    name: str
    type: Literal["string", "list"]
    description: str = ""


async def load_config(storage: Storage) -> dict:
    """Load vault config as a raw dict, returning empty if absent."""
    content = await storage.read(CONFIG_PATH, strict=False)
    if content is None:
        return {}
    raw = _yaml.load(content)
    return dict(raw) if raw else {}


def load_default_config_text() -> str:
    """Read the package-bundled default config.yaml."""
    return DEFAULT_CONFIG_PATH.read_text(encoding="utf-8")


def load_enriched_field_specs(config: dict) -> list[EnrichedFieldSpec]:
    """Parse the flat ``metadata:`` block into typed field specs.

    Vaults that haven't authored a ``metadata:`` block (or whose block
    is the legacy per-content-type shape) get an empty list — extract
    runs with the universal fields only.
    """
    metadata = config.get("metadata")
    if not isinstance(metadata, dict):
        return []
    specs: list[EnrichedFieldSpec] = []
    for name, defn in metadata.items():
        if not isinstance(defn, dict):
            continue
        type_ = defn.get("type")
        if type_ not in ("string", "list"):
            continue
        specs.append(
            EnrichedFieldSpec(
                name=name,
                type=type_,
                description=defn.get("description", ""),
            )
        )
    return specs


@dataclass(frozen=True)
class VaultConfig:
    """Parsed view of the compile-relevant sections of config.yaml.

    `raw` preserves the full dict so callers that need other sections
    can access them without a second load.
    """

    kinds: tuple[str, ...] = DEFAULT_KINDS
    thematic_hint: str = DEFAULT_THEMATIC_HINT
    enriched_fields: tuple[EnrichedFieldSpec, ...] = ()
    raw: dict = field(default_factory=dict)


async def load_vault_config(storage: Storage) -> VaultConfig:
    content = await storage.read(CONFIG_PATH, strict=False)
    if content is None:
        return VaultConfig()
    data = _yaml.load(content) or {}
    kinds_raw = data.get("kinds")
    kinds = tuple(kinds_raw) if kinds_raw else DEFAULT_KINDS
    thematic_hint = data.get("thematic_hint") or DEFAULT_THEMATIC_HINT
    enriched_fields = tuple(load_enriched_field_specs(dict(data)))
    return VaultConfig(
        kinds=kinds,
        thematic_hint=thematic_hint,
        enriched_fields=enriched_fields,
        raw=dict(data),
    )


async def apply_vault_config_overrides(
    storage: Storage,
    *,
    thematic_hint: str | None = None,
    kinds: list[str] | None = None,
) -> None:
    """Merge overrides into the vault's config.yaml.

    Reads the existing file (or falls back to the package default if
    the vault doesn't have one yet), applies the overrides, and writes
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
