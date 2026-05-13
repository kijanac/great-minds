"""Phase 1 — extract.

One LLM call per document. Produces a SourceCard (title, doc_metadata,
precis, ideas with anchors) and corresponding idea embeddings. Per-doc
cache keyed on sha256(doc_content + prompt_hash + kinds_config +
extract_model) short-circuits the LLM + embedding work for incremental
compiles.

Per-source-type metadata fields (tradition, interlocutors, outlet, etc.)
are pulled from the vault's config.yaml metadata.<source_type> section
via documents.builder.load_field_specs and formatted into the prompt's
{extra_fields} slot. Universal fields (genre, tags) are hardcoded.
"""

import asyncio
import json
import logging
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from uuid import UUID, uuid7

from openai import AsyncOpenAI
from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.core.compile_cache import CompileCacheRepository
from great_minds.core.vaults.prompts import load_prompt
from great_minds.core.documents import SourceDocumentService
from great_minds.core.llm.client import json_llm_call
from great_minds.core.hashing import content_hash, prompt_hash
from great_minds.core.markdown import (
    normalized_bodies,
    paragraph_for_quote,
    paragraphs,
    parse_frontmatter,
)
from great_minds.core.ideas.schemas import (
    Anchor,
    DocMetadata,
    Idea,
    IdeaEmbedding,
    SourceCard,
)
from great_minds.core.ideas.service import IdeaService
from great_minds.core.documents.builder import load_field_specs
from great_minds.core.llm import EXTRACT_MODEL
from great_minds.core.llm.providers import (
    EMBEDDING_DIMENSIONS,
    EMBEDDING_MODEL,
)
from great_minds.core.pipeline_runs import (
    PipelineProgressRunner,
    PipelineProgressStep,
    build_progress_steps,
)
from great_minds.core.llm import truncate_and_normalize
from great_minds.core.storage import Storage
from great_minds.core.telemetry import enrich, log_event
from great_minds.core.vaults.config import VaultConfig

log = logging.getLogger(__name__)

PHASE = "extract"
EMBEDDING_BATCH_SIZE = 50

EXTRACT_STEP_LABELS = {
    "load_documents": "Preparing document list",
    "extract_cards": "Extracting source cards",
    "embed_ideas": "Embedding ideas",
    "save_index": "Saving extraction index",
}


class ExtractPhase:
    """Phase 1 runner with explicit service-style dependencies."""

    def __init__(
        self,
        *,
        storage: Storage,
        client: AsyncOpenAI,
        session: AsyncSession,
        progress: PipelineProgressRunner,
        compile_cache: CompileCacheRepository,
        source_docs: SourceDocumentService,
        ideas: IdeaService,
        config: VaultConfig,
        concurrency: int,
    ) -> None:
        self.storage = storage
        self.client = client
        self.session = session
        self.progress = progress
        self.compile_cache = compile_cache
        self.source_docs = source_docs
        self.ideas = ideas
        self.config = config
        self.concurrency = concurrency

    def progress_steps(
        self,
        active: str,
        *,
        completed: set[str] | None = None,
        failed: set[str] | None = None,
        counts: dict[str, tuple[int | None, int | None]] | None = None,
        details: dict[str, str] | None = None,
    ) -> list[PipelineProgressStep]:
        return build_progress_steps(
            EXTRACT_STEP_LABELS,
            active,
            completed=completed,
            failed=failed,
            counts=counts,
            details=details,
        )

    async def run(self, vault_id: UUID, pipeline_run_id: UUID) -> None:
        """Extract every raw document registered in the DB for this vault.

        The documents table is the authoritative registry — ingest writes
        the file and the DB row together, so iterating the registry catches
        every document. If a DB row points at a file that's missing from
        storage, _extract_one records file_not_found via
        storage.read(strict=False).
        """
        prompt_template = await load_prompt(self.storage, "extract")
        ph = prompt_hash(prompt_template)
        kinds_key = "|".join(sorted(self.config.kinds))

        docs = await self.source_docs.list_all(vault_id)
        total_docs = len(docs)
        await self.progress.emit(
            pipeline_run_id=pipeline_run_id,
            phase="extract",
            status="progress",
            steps=self.progress_steps(
                "extract_cards",
                completed={"load_documents"},
                counts={"extract_cards": (0, total_docs)},
            ),
        )

        sem = asyncio.Semaphore(self.concurrency)
        tasks = [
            _extract_one(
                phase=self,
                sem=sem,
                vault_id=vault_id,
                raw_path=doc.file_path,
                document_id=doc.id,
                source_type=doc.source_type,
                body_hash=doc.body_hash,
                prompt_template=prompt_template,
                prompt_hash=ph,
                kinds_key=kinds_key,
            )
            for doc in docs
        ]

        outcomes: list[_ExtractOutcome] = []
        docs_completed = 0
        for task in asyncio.as_completed(tasks):
            outcome = await task
            outcomes.append(outcome)
            docs_completed += 1
            if total_docs > 0:
                await self.progress.emit(
                    pipeline_run_id=pipeline_run_id,
                    phase="extract",
                    status="progress",
                    steps=self.progress_steps(
                        "extract_cards",
                        completed={"load_documents"},
                        counts={"extract_cards": (docs_completed, total_docs)},
                    ),
                )

        # Per-doc trackers for the embedding loop. Populated only inside
        # the success branch below where source_card is narrowed to non-None.
        cards: list[SourceCard] = []
        embedding_inputs: list[tuple[UUID, UUID, Idea]] = []
        fresh_source_cards: dict[UUID, SourceCard] = {}
        idea_repo = self.ideas.embedding_repo
        existing_embedding_ids = set(await idea_repo.get_ids_for_vault(vault_id))
        docs_extracted = 0
        cache_hits = 0
        cache_misses = 0
        docs_failed = 0
        ideas_emitted = 0

        for outcome in outcomes:
            if outcome.error is not None:
                docs_failed += 1
                log_event(
                    "doc_failed",
                    level=logging.WARNING,
                    path=outcome.raw_path,
                    error=outcome.error,
                )
                continue
            source_card = outcome.source_card
            if source_card is None:
                # Unreachable in practice: success path always sets source_card.
                continue
            docs_extracted += 1
            cards.append(source_card)
            ideas_emitted += len(source_card.ideas)
            if outcome.cache_hit:
                cache_hits += 1
                for idea in source_card.ideas:
                    if idea.idea_id not in existing_embedding_ids:
                        embedding_inputs.append((vault_id, outcome.document_id, idea))
            else:
                cache_misses += 1
                fresh_source_cards[outcome.document_id] = source_card
                await _write_cache(
                    compile_cache=self.compile_cache,
                    session=self.session,
                    vault_id=vault_id,
                    cache_key=outcome.cache_key,
                    source_card=source_card,
                )
                for idea in source_card.ideas:
                    embedding_inputs.append((vault_id, outcome.document_id, idea))

        # Extract cache stores only the LLM output (SourceCard). Embeddings are
        # derived vector-index rows in idea_embeddings; if a crash happens after
        # caching but before embedding upsert, replay reuses the SourceCard and
        # regenerates only missing embeddings.
        total_embedding_batches = (
            len(embedding_inputs) + EMBEDDING_BATCH_SIZE - 1
        ) // EMBEDDING_BATCH_SIZE
        await self.progress.emit(
            pipeline_run_id=pipeline_run_id,
            phase="extract",
            status="progress",
            steps=self.progress_steps(
                "embed_ideas",
                completed={"load_documents", "extract_cards"},
                counts={
                    "extract_cards": (docs_completed, total_docs),
                    "embed_ideas": (0, total_embedding_batches),
                },
            ),
        )
        fresh_embeddings: list[IdeaEmbedding] = []
        embedding_batches_done = 0
        async for batch in _embed_in_batches(self.client, embedding_inputs):
            fresh_embeddings.extend(batch)
            embedding_batches_done += 1
            await self.progress.emit(
                pipeline_run_id=pipeline_run_id,
                phase="extract",
                status="progress",
                steps=self.progress_steps(
                    "embed_ideas",
                    completed={"load_documents", "extract_cards"},
                    counts={
                        "extract_cards": (docs_completed, total_docs),
                        "embed_ideas": (
                            embedding_batches_done,
                            total_embedding_batches,
                        ),
                    },
                ),
            )
        await self.progress.emit(
            pipeline_run_id=pipeline_run_id,
            phase="extract",
            status="progress",
            steps=self.progress_steps(
                "save_index",
                completed={"load_documents", "extract_cards", "embed_ideas"},
                counts={
                    "extract_cards": (docs_completed, total_docs),
                    "embed_ideas": (embedding_batches_done, total_embedding_batches),
                },
            ),
        )
        for doc_id in fresh_source_cards:
            await idea_repo.delete_for_document(doc_id)
        await self.ideas.record_extractions(cards, fresh_embeddings)
        await self.source_docs.update_metadata_from_cards(vault_id, cards)
        await self.session.commit()

        enrich(
            docs_extracted=docs_extracted,
            cache_hits=cache_hits,
            cache_misses=cache_misses,
            docs_failed=docs_failed,
            ideas_emitted=ideas_emitted,
        )
        log_event(
            "completed",
            docs_extracted=docs_extracted,
            cache_hits=cache_hits,
            cache_misses=cache_misses,
            docs_failed=docs_failed,
            ideas_emitted=ideas_emitted,
        )
        await self.progress.emit(
            pipeline_run_id=pipeline_run_id,
            phase="extract",
            status="completed",
            steps=self.progress_steps(
                "save_index",
                completed={
                    "load_documents",
                    "extract_cards",
                    "embed_ideas",
                    "save_index",
                },
                counts={
                    "extract_cards": (docs_completed, total_docs),
                    "embed_ideas": (embedding_batches_done, total_embedding_batches),
                },
            ),
        )


# ---------------------------------------------------------------------------
# Per-doc extraction
# ---------------------------------------------------------------------------


@dataclass
class _ExtractOutcome:
    raw_path: str
    document_id: UUID
    source_card: SourceCard | None = None
    embeddings: list[IdeaEmbedding] = field(default_factory=list)
    cache_key: str = ""
    cache_hit: bool = False
    error: str | None = None


async def _extract_one(
    *,
    phase: ExtractPhase,
    sem: asyncio.Semaphore,
    vault_id: UUID,
    raw_path: str,
    document_id: UUID,
    source_type: str,
    body_hash: str,
    prompt_template: str,
    prompt_hash: str,
    kinds_key: str,
) -> _ExtractOutcome:
    outcome = _ExtractOutcome(raw_path=raw_path, document_id=document_id)
    try:
        cache_key = _cache_key(
            body_hash=body_hash,
            prompt_hash=prompt_hash,
            kinds_key=kinds_key,
            source_type=source_type,
        )
        outcome.cache_key = cache_key

        cached = await phase.compile_cache.get(
            vault_id=vault_id,
            phase=PHASE,
            cache_key=cache_key,
        )
        if cached is not None:
            outcome.source_card = SourceCard.model_validate(cached["source_card"])
            outcome.cache_hit = True
            return outcome

        # Cache miss: only now do we need the body to feed the LLM.
        content = await phase.storage.read(raw_path, strict=False)
        if content is None:
            outcome.error = "file_not_found"
            return outcome
        _, body = parse_frontmatter(content)

        async with sem:
            prompt = _render_prompt(
                prompt_template=prompt_template,
                kinds=phase.config.kinds,
                source_type=source_type,
                doc_content=body,
                config_raw=phase.config.raw,
            )
            data = await json_llm_call(
                phase.client,
                model=EXTRACT_MODEL,
                messages=[{"role": "user", "content": prompt}],
                temperature=0.2,
            )
        outcome.source_card = _validate_extract_output(
            data=data,
            document_id=document_id,
            allowed_kinds=phase.config.kinds,
        )
        _localize_anchors(outcome.source_card, body)
    except json.JSONDecodeError as e:
        outcome.error = f"json_parse_exhausted:{e}"
    except ValidationError as e:
        outcome.error = f"schema_invalid:{str(e)[:200]}"
    except Exception as e:
        outcome.error = f"llm_call:{repr(e)[:200]}"
        log_event(
            "doc_failed",
            level=logging.WARNING,
            path=raw_path,
            error=outcome.error,
        )
    return outcome


def _cache_key(
    *, body_hash: str, prompt_hash: str, kinds_key: str, source_type: str
) -> str:
    return content_hash(
        body_hash,
        f"prompt={prompt_hash}",
        f"kinds={kinds_key}",
        f"source_type={source_type}",
        f"model={EXTRACT_MODEL}",
    )


def _render_prompt(
    *,
    prompt_template: str,
    kinds: tuple[str, ...],
    source_type: str,
    doc_content: str,
    config_raw: dict,
) -> str:
    extra_fields = _build_extra_fields(config_raw, source_type)
    return (
        prompt_template.replace("{kinds}", ", ".join(kinds))
        .replace("{source_type}", source_type)
        .replace("{extra_fields}", extra_fields)
        .replace("{doc_content}", doc_content)
    )


def _build_extra_fields(config_raw: dict, source_type: str) -> str:
    """Format per-source-type enriched fields into prompt lines.

    Pulls from config.metadata.<source_type>, keeps fields with
    source=="enriched", writes lines matching the sibling genre/tags
    entries' format. Returns empty string if the vault has no
    per-source-type enriched fields.
    """
    try:
        specs = load_field_specs(config_raw, source_type)
    except ValueError:
        return ""
    enriched = [s for s in specs if s.source == "enriched"]
    if not enriched:
        return ""
    lines = []
    for spec in enriched:
        kind_hint = "array of strings" if spec.type == "list" else "string or null"
        desc = spec.description.strip() if spec.description else f"{spec.name} value"
        lines.append(f"    - `{spec.name}` ({kind_hint}): {desc}")
    return "\n".join(lines)


def _localize_anchors(source_card: SourceCard, body: str) -> None:
    """Fill anchor.chunk_index via substring match against body paragraphs.

    Mutates in place. Unmatchable quotes (LLM normalized whitespace,
    punctuation drift, etc.) leave chunk_index=None — render will still
    emit the footnote, just without a deep-link fragment.
    """
    paras = paragraphs(body)
    if not paras:
        return
    bodies = normalized_bodies(paras)
    for idea in source_card.ideas:
        for anchor in idea.anchors:
            anchor.chunk_index = paragraph_for_quote(anchor.quote, bodies)


def _validate_extract_output(
    *,
    data: dict,
    document_id: UUID,
    allowed_kinds: tuple[str, ...],
) -> SourceCard:
    """Validate raw LLM output into a SourceCard.

    Mints uuid7 for each idea. Coerces unknown kinds to "other" rather
    than failing — the LLM may drift and a single odd kind shouldn't
    tank the whole doc.
    """
    allowed = set(allowed_kinds)
    ideas_raw = data.get("ideas") or []
    ideas: list[Idea] = []
    for raw_idea in ideas_raw:
        kind = raw_idea.get("kind") or "other"
        if kind not in allowed and kind != "other":
            kind = "other"
        anchors = [
            Anchor(
                anchor_id=str(a.get("anchor_id") or f"a{i + 1}"),
                claim=a.get("claim") or "",
                quote=a.get("quote") or "",
            )
            for i, a in enumerate(raw_idea.get("anchors") or [])
        ]
        ideas.append(
            Idea(
                idea_id=uuid7(),
                document_id=document_id,
                kind=kind,
                label=raw_idea.get("label") or "",
                description=raw_idea.get("description") or "",
                anchors=anchors,
            )
        )

    doc_metadata = DocMetadata.model_validate(data.get("doc_metadata") or {})

    return SourceCard(
        document_id=document_id,
        title=data.get("title") or "",
        doc_metadata=doc_metadata,
        precis=data.get("precis") or "",
        ideas=ideas,
    )


# ---------------------------------------------------------------------------
# Embedding
# ---------------------------------------------------------------------------


async def _embed_in_batches(
    client, inputs: list[tuple[UUID, UUID, Idea]]
) -> AsyncIterator[list[IdeaEmbedding]]:
    """Yield IdeaEmbedding lists one batch at a time.

    Per-batch yielding lets the caller checkpoint cache writes as docs
    finish embedding, instead of waiting for the whole list to complete.
    """
    for start in range(0, len(inputs), EMBEDDING_BATCH_SIZE):
        batch_inputs = inputs[start : start + EMBEDDING_BATCH_SIZE]
        texts = [
            f"{idea.label}. {idea.description}".strip() for _, _, idea in batch_inputs
        ]
        response = await client.embeddings.create(model=EMBEDDING_MODEL, input=texts)
        out: list[IdeaEmbedding] = []
        for (vault_id, document_id, idea), item in zip(batch_inputs, response.data):
            vec = truncate_and_normalize(item.embedding, EMBEDDING_DIMENSIONS)
            out.append(
                IdeaEmbedding(
                    idea_id=idea.idea_id,
                    vault_id=vault_id,
                    document_id=document_id,
                    kind=idea.kind,
                    label=idea.label,
                    description=idea.description,
                    embedding=vec,
                )
            )
        yield out


# ---------------------------------------------------------------------------
# DB persistence helpers
# ---------------------------------------------------------------------------


async def _write_cache(
    *,
    compile_cache: CompileCacheRepository,
    session: AsyncSession,
    vault_id: UUID,
    cache_key: str,
    source_card: SourceCard,
) -> None:
    await compile_cache.put(
        vault_id=vault_id,
        phase=PHASE,
        cache_key=cache_key,
        value={"source_card": source_card.model_dump(mode="json")},
    )
    # Extract writes cache entries before embedding/vector-index upserts.
    # Commit each entry so a mid-phase crash can replay from DB cache and
    # repair missing idea/document/vector rows without repeating LLM work.
    await session.commit()
