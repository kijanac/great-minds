"""Phase 2d — canonicalize.

Two-step LLM construction of the canonical article-level registry,
replacing the old single bind-everything reduce. That reduce over-merged
~1,800 local topics into a handful of catch-alls because emitting a
complete 1,800-way partition in one generation is unreliable — the model
lumps most items into a few buckets and silently drops the rest.

  1. registry — one LLM call over local-topic titles/descriptions/idea
     counts produces the canonical topic set (title + description +
     link_targets). Slugs are derived code-side for determinism.
  2. assign   — every local topic is *classified* into exactly one
     canonical (batched LLM calls). Classification framing makes the
     result orphan-free by construction: each local lands somewhere and
     no topic can silently swallow the corpus.

The two steps assemble into the same ``CanonicalTopicDraft`` list the
validate phase consumes, so the contract with the rest of the pipeline
is unchanged.

Caching: the registry call and each assignment batch are memoized
separately by content hash, so re-running an unchanged compile is free
and one changed local topic re-runs only the batch it touches (plus the
registry). Orthogonally, when batches do run, the shared registry block
is sent as a prompt-cache breakpoint so the provider charges read price
for it across batches instead of full input each time. Local topics are
sorted only to give stable batch composition (so an unchanged batch
keeps hitting its cache) — NOT for convergence.
Convergence/path-independence comes from recomputing the registry over
the whole current local-topic set every compile (modulo LLM
nondeterminism, frozen by the cache); input order does not affect it.
"""

import asyncio
import logging
import re
from uuid import UUID

from openai import AsyncOpenAI
from pydantic import BaseModel, ConfigDict

from great_minds.core.compile_cache import CompileCacheRepository
from great_minds.core.hashing import content_hash, prompt_hash
from great_minds.core.llm import REDUCE_MODEL
from great_minds.core.llm.client import json_llm_call
from great_minds.core.pipeline.abstract.schemas import LocalTopic
from great_minds.core.storage import Storage
from great_minds.core.telemetry import enrich, log_event
from great_minds.core.topics.schemas import CanonicalTopicDraft
from great_minds.core.vaults.prompts import load_prompt

log = logging.getLogger(__name__)

PHASE_REGISTRY = "canonicalize_registry"
PHASE_ASSIGN = "canonicalize_assign"

_ASSIGN_BATCH_SIZE = 30
_SLUG_RE = re.compile(r"[^a-z0-9]+")

# Strict structured-output schemas, so the registry / assign JSON shape is
# enforced at the API (extract already does this for its output). Without this
# the calls only request `json_object` — valid JSON of any shape — so each model
# returns its own structure and the parsers, which assume one shape, break.
# Slugs are intentionally absent from the registry schema: they are derived
# code-side in `_parse_registry`, not echoed by the model.
_REGISTRY_SCHEMA = {
    "type": "json_schema",
    "json_schema": {
        "name": "registry",
        "strict": True,
        "schema": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "topics": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "additionalProperties": False,
                        "properties": {
                            "title": {"type": "string"},
                            "description": {"type": "string"},
                            "link_targets": {
                                "type": "array",
                                "items": {"type": "string"},
                            },
                        },
                        "required": ["title", "description", "link_targets"],
                    },
                }
            },
            "required": ["topics"],
        },
    },
}

_ASSIGN_SCHEMA = {
    "type": "json_schema",
    "json_schema": {
        "name": "assignments",
        "strict": True,
        "schema": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "assignments": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "additionalProperties": False,
                        "properties": {
                            "n": {"type": "integer"},
                            "slug": {"type": "string"},
                        },
                        "required": ["n", "slug"],
                    },
                }
            },
            "required": ["assignments"],
        },
    },
}


class _RegistryTopic(BaseModel):
    """A registry topic after code-side slug derivation.

    Internal to canonicalize — held between step 1 and assembly, and
    round-tripped through the registry cache via ``model_dump`` /
    ``model_validate``. ``link_target_titles`` are still the raw titles
    the registry LLM emitted; they are resolved to slugs at assembly time.
    """

    model_config = ConfigDict(frozen=True)

    slug: str
    title: str
    description: str
    link_target_titles: list[str]


class CanonicalizePhase:
    """Phase 2d runner with explicit service-style dependencies."""

    def __init__(
        self,
        *,
        storage: Storage,
        client: AsyncOpenAI,
        compile_cache: CompileCacheRepository,
        thematic_hint: str,
        concurrency: int,
    ) -> None:
        self.storage = storage
        self.client = client
        self.compile_cache = compile_cache
        self.thematic_hint = thematic_hint
        self.concurrency = concurrency

    async def run(
        self, vault_id: UUID, local_topics: list[LocalTopic]
    ) -> list[CanonicalTopicDraft]:
        """Build the canonical registry, then classify every local into it.

        Returns one ``CanonicalTopicDraft`` per canonical topic that
        received at least one local topic. Empty canonicals are dropped
        (they back no article); unassigned locals are counted as orphans.
        """
        if not local_topics:
            log_event("skipped", reason="no_local_topics")
            return []

        ordered = sorted(local_topics, key=lambda t: str(t.local_topic_id))

        registry = await self._build_registry(vault_id, ordered)
        if not registry:
            log_event("skipped", reason="empty_registry")
            return []

        assignment = await self._assign(vault_id, ordered, registry)

        title_to_slug = {t.title: t.slug for t in registry}
        members: dict[str, list[UUID]] = {}
        for lt in ordered:
            slug = assignment.get(lt.local_topic_id)
            if slug is not None:
                members.setdefault(slug, []).append(lt.local_topic_id)

        drafts: list[CanonicalTopicDraft] = []
        for t in registry:
            ids = members.get(t.slug)
            if not ids:
                continue
            link_targets = list(
                dict.fromkeys(
                    title_to_slug[title]
                    for title in t.link_target_titles
                    if title in title_to_slug and title_to_slug[title] != t.slug
                )
            )
            drafts.append(
                CanonicalTopicDraft(
                    slug=t.slug,
                    title=t.title,
                    description=t.description,
                    merged_local_topic_ids=sorted(ids, key=str),
                    link_targets=link_targets,
                )
            )

        assigned = sum(len(v) for v in members.values())
        orphans = len(ordered) - assigned
        enrich(
            canonicalize_registry_size=len(registry),
            canonicalize_canonical_count=len(drafts),
            canonicalize_assigned=assigned,
            canonicalize_orphan_count=orphans,
            canonicalize_empty_topics=len(registry) - len(drafts),
        )
        log_event(
            "completed",
            registry_size=len(registry),
            canonical_count=len(drafts),
            assigned=assigned,
            orphan_count=orphans,
            empty_topics=len(registry) - len(drafts),
        )
        return drafts

    # -- step 1: registry ---------------------------------------------------

    async def _build_registry(
        self, vault_id: UUID, ordered: list[LocalTopic]
    ) -> list[_RegistryTopic]:
        template = await load_prompt(self.storage, "canonicalize_registry")
        ph = prompt_hash(template)
        cache_key = _registry_cache_key(ordered, ph, self.thematic_hint)

        cached = await self.compile_cache.get(
            vault_id=vault_id, phase=PHASE_REGISTRY, cache_key=cache_key
        )
        if cached is not None:
            return [_RegistryTopic.model_validate(t) for t in cached["topics"]]

        prompt = template.replace(
            "{thematic_hint_block}", _hint_block(self.thematic_hint)
        ).replace("{local_topic_block}", _registry_input_block(ordered))
        data = await json_llm_call(
            self.client,
            model=REDUCE_MODEL,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.2,
            response_format=_REGISTRY_SCHEMA,
        )
        registry = _parse_registry(data)
        await self.compile_cache.put(
            vault_id=vault_id,
            phase=PHASE_REGISTRY,
            cache_key=cache_key,
            value={"topics": [t.model_dump(mode="json") for t in registry]},
        )
        return registry

    # -- step 2: assignment -------------------------------------------------

    async def _assign(
        self,
        vault_id: UUID,
        ordered: list[LocalTopic],
        registry: list[_RegistryTopic],
    ) -> dict[UUID, str]:
        template = await load_prompt(self.storage, "canonicalize_assign")
        ph = prompt_hash(template)
        registry_block = "\n".join(
            f"- {t.slug} — {t.title}: {t.description}" for t in registry
        )
        slugset = {t.slug for t in registry}
        registry_sig = content_hash(
            *(f"{t.slug}|{t.title}|{t.description}" for t in registry)
        )

        # The registry block is identical across every batch, so render the
        # stable prefix (instructions + registry) once and mark it as a
        # prompt-cache breakpoint. Each batch's request is then prefix
        # (cached) + its own cheap sub-topic suffix — the provider charges
        # the read price for the prefix instead of the full input each time.
        head, tail = template.split("{subtopics_block}", 1)
        prefix = head.replace("{registry_block}", registry_block)

        batches = [
            ordered[i : i + _ASSIGN_BATCH_SIZE]
            for i in range(0, len(ordered), _ASSIGN_BATCH_SIZE)
        ]
        sem = asyncio.Semaphore(self.concurrency)

        async def classify(batch: list[LocalTopic]) -> dict[UUID, str]:
            cache_key = _assign_cache_key(batch, registry_sig, ph)
            cached = await self.compile_cache.get(
                vault_id=vault_id, phase=PHASE_ASSIGN, cache_key=cache_key
            )
            if cached is not None:
                return {UUID(k): v for k, v in cached["assign"].items()}

            subtopics_block = "\n".join(
                f"{i + 1}. {lt.title} :: {lt.description}" for i, lt in enumerate(batch)
            )
            content = [
                {
                    "type": "text",
                    "text": prefix,
                    "cache_control": {"type": "ephemeral"},
                },
                {"type": "text", "text": subtopics_block + tail},
            ]
            async with sem:
                data = await json_llm_call(
                    self.client,
                    model=REDUCE_MODEL,
                    messages=[{"role": "user", "content": content}],
                    temperature=0.1,
                    response_format=_ASSIGN_SCHEMA,
                    max_parse_retries=2,
                )
            out = _parse_assignments(data, batch, slugset)
            await self.compile_cache.put(
                vault_id=vault_id,
                phase=PHASE_ASSIGN,
                cache_key=cache_key,
                value={"assign": {str(k): v for k, v in out.items()}},
            )
            return out

        # Warm the prefix cache with the first batch before fanning out, so
        # the rest read the cached registry rather than each racing to
        # recreate it (cache writes cost more than reads).
        assignment: dict[UUID, str] = {}
        if batches:
            assignment.update(await classify(batches[0]))
            for result in await asyncio.gather(*(classify(b) for b in batches[1:])):
                assignment.update(result)
        return assignment


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------


def _hint_block(thematic_hint: str) -> str:
    if not thematic_hint.strip():
        return ""
    return f"The wiki's editorial lens for this vault:\n\n{thematic_hint.strip()}\n\n"


def _registry_input_block(ordered: list[LocalTopic]) -> str:
    return "\n".join(
        f"- {t.title} :: {t.description} [{len(t.subsumed_idea_ids)} ideas]"
        for t in ordered
    )


def _slugify(title: str, seen: set[str]) -> str:
    base = _SLUG_RE.sub("-", title.lower().replace("'", "")).strip("-") or "topic"
    slug = base
    i = 2
    while slug in seen:
        slug = f"{base}-{i}"
        i += 1
    seen.add(slug)
    return slug


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------


def _parse_registry(data: dict) -> list[_RegistryTopic]:
    """Parse the registry LLM JSON; derive a unique slug per topic.

    Topics with no title are dropped. Slugs are derived code-side
    (deterministic given titles + order) so identity does not depend on
    the model echoing a slug back.
    """
    out: list[_RegistryTopic] = []
    seen: set[str] = set()
    for raw in data.get("topics") or []:
        title = (raw.get("title") or "").strip()
        if not title:
            continue
        description = (raw.get("description") or "").strip()
        out.append(
            _RegistryTopic(
                slug=_slugify(title, seen),
                title=title,
                description=description,
                link_target_titles=raw.get("link_targets") or [],
            )
        )
    return out


def _parse_assignments(
    data: dict, batch: list[LocalTopic], slugset: set[str]
) -> dict[UUID, str]:
    """Map a batch's 1-based sub-topic numbers to canonical slugs.

    Drops entries with an out-of-range number or an unknown slug
    (hallucinations) — those locals fall through as orphans rather than
    poisoning the registry.
    """
    out: dict[UUID, str] = {}
    for raw in data.get("assignments") or []:
        n = raw.get("n")
        slug = raw.get("slug")
        if isinstance(n, int) and 1 <= n <= len(batch) and slug in slugset:
            out[batch[n - 1].local_topic_id] = slug
    return out


# ---------------------------------------------------------------------------
# Cache keys
# ---------------------------------------------------------------------------


def _local_sig(lt: LocalTopic) -> str:
    return content_hash(lt.title, lt.description, str(len(lt.subsumed_idea_ids)))


def _registry_cache_key(
    ordered: list[LocalTopic], prompt_hash: str, thematic_hint: str
) -> str:
    return content_hash(
        *(_local_sig(t) for t in ordered),
        f"prompt={prompt_hash}",
        f"hint={content_hash(thematic_hint)}",
        f"model={REDUCE_MODEL}",
    )


def _assign_cache_key(
    batch: list[LocalTopic], registry_sig: str, prompt_hash: str
) -> str:
    return content_hash(
        f"registry={registry_sig}",
        *(f"{t.local_topic_id}:{content_hash(t.title, t.description)}" for t in batch),
        f"prompt={prompt_hash}",
        f"model={REDUCE_MODEL}",
    )
