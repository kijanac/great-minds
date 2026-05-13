"""Ingest service: content conversion, ingestion, and indexing."""

import asyncio
import io
from datetime import datetime, timezone
from enum import StrEnum
from pathlib import PurePosixPath
from uuid import UUID

import httpx
from markitdown import MarkItDown, StreamInfo

from great_minds.core.compile_intents.repository import CompileIntentRepository
from great_minds.core.documents.builder import write_document
from great_minds.core.documents.schemas import IngestedDocument, SourceMetadata
from great_minds.core.documents.service import SourceDocumentService
from great_minds.core.ingest_schemas import StagedFileInput, StagedFileSignedUpload
from great_minds.core.paths import raw_path, session_exchange_path
from great_minds.core.pipeline_runs.repository import PipelineRunRepository
from great_minds.core.r2_admin import R2Admin
from great_minds.core.sessions.schemas import ExchangeEvent, SessionOrigin
from great_minds.core.sessions.service import SessionService
from great_minds.core.settings import Settings
from great_minds.core.storage import Storage
from great_minds.core.text import normalize_url, slugify
from great_minds.core.vaults.config import load_config
from great_minds.core.vaults.service import VaultService


class UserSuggestionIntent(StrEnum):
    DISAGREE = "disagree"
    CORRECT = "correct"
    ADD_CONTEXT = "add_context"
    RESTRUCTURE = "restructure"


class IngestService:
    """Coordinator for the API-side ingest entry points.

    Each public ``ingest_*`` method is an input adapter — it derives
    ``content``, ``dest``, and frontmatter extras from its source
    (text, upload, URL, suggestion, session exchange) and funnels them
    into ``_ingest_raw``, which loads vault config, builds the markdown
    via ``write_document``, and indexes the document row.
    """

    def __init__(
        self,
        doc_service: SourceDocumentService,
        *,
        intent_repo: CompileIntentRepository,
        pipeline_run_repo: PipelineRunRepository,
        vault_service: VaultService,
        settings: Settings,
    ) -> None:
        self.doc_service = doc_service
        self.intent_repo = intent_repo
        self.pipeline_run_repo = pipeline_run_repo
        self.vault_service = vault_service
        self.settings = settings

    async def _emit_compile_intent(
        self, vault_id: UUID, pipeline_run_id: UUID | None
    ) -> None:
        intent = await self.intent_repo.ensure_pending(
            vault_id, pipeline_run_id=pipeline_run_id
        )
        if pipeline_run_id is None:
            return
        if intent.pipeline_run_id is None:
            await self.intent_repo.attach_pipeline_run(intent.id, pipeline_run_id)
        await self.pipeline_run_repo.attach_compile_intent(pipeline_run_id, intent.id)

    async def sign_staged_files(
        self,
        vault_id: UUID,
        files: list[StagedFileInput],
    ) -> list[StagedFileSignedUpload]:
        """Create presigned R2 PUT URLs for direct-to-staging uploads."""
        if self.settings.storage_backend != "r2":
            raise ValueError("staged file upload requires r2 storage backend")
        if not files:
            raise ValueError("manifest is empty")

        vault = await self.vault_service.get_vault(vault_id)
        if not vault.r2_bucket_name:
            raise ValueError("vault has no r2 bucket; cannot sign uploads")

        admin = R2Admin(
            account_id=self.settings.r2_account_id,
            access_key_id=self.settings.r2_access_key_id,
            secret_access_key=self.settings.r2_secret_access_key,
        )
        signed: list[StagedFileSignedUpload] = []
        for f in files:
            url = admin.presign_put(
                vault.r2_bucket_name,
                f"staging/{vault_id}/{f.hash}",
                content_type=f.mimetype or "application/octet-stream",
                content_length=f.size,
            )
            signed.append(StagedFileSignedUpload(hash=f.hash, url=url))
        return signed

    async def _ingest_raw(
        self,
        vault_id: UUID,
        storage: Storage,
        *,
        pipeline_run_id: UUID | None,
        content: str,
        content_type: str,
        dest: str,
        source_type: str,
        **frontmatter: object,
    ) -> UUID:
        """Build markdown from raw content + metadata, write, index, and
        guarantee a compile intent exists in the same transaction."""
        config = await load_config(storage)
        rendered = await write_document(
            storage,
            config,
            content,
            content_type,
            dest=dest,
            source_type=source_type,
            **frontmatter,
        )
        doc_id = await self.doc_service.index(vault_id, dest, rendered)
        await self._emit_compile_intent(vault_id, pipeline_run_id)
        return doc_id

    async def ingest_text(
        self,
        vault_id: UUID,
        storage: Storage,
        content: str,
        dest: str,
        metadata: SourceMetadata,
        *,
        pipeline_run_id: UUID | None = None,
    ) -> IngestedDocument:
        """Ingest raw text content."""
        await self._ingest_raw(
            vault_id,
            storage,
            pipeline_run_id=pipeline_run_id,
            content=content,
            content_type=metadata.content_type,
            dest=dest,
            source_type=metadata.source_type,
            **_metadata_extras(metadata),
        )
        return IngestedDocument(
            file_path=dest,
            title=metadata.title or dest,
        )

    async def ingest_upload(
        self,
        vault_id: UUID,
        storage: Storage,
        raw_bytes: bytes,
        filename: str,
        metadata: SourceMetadata,
        *,
        mimetype: str = "",
        dest_path: str | None = None,
        pipeline_run_id: UUID | None = None,
    ) -> IngestedDocument:
        """Ingest an uploaded file."""
        content = await _convert_to_markdown(raw_bytes, filename, mimetype)

        if dest_path:
            dest = _safe_upload_dest(metadata.content_type, dest_path)
        else:
            slug = slugify(filename.rsplit(".", 1)[0])
            dest = _safe_upload_dest(metadata.content_type, f"{slug}.md")

        await self._ingest_raw(
            vault_id,
            storage,
            pipeline_run_id=pipeline_run_id,
            content=content,
            content_type=metadata.content_type,
            dest=dest,
            source_type=metadata.source_type,
            **_metadata_extras(metadata),
        )
        return IngestedDocument(
            file_path=dest,
            title=metadata.title or filename,
        )

    async def ingest_user_suggestion(
        self,
        vault_id: UUID,
        storage: Storage,
        *,
        body: str,
        intent: UserSuggestionIntent,
        anchored_to: str = "",
        anchored_section: str = "",
        pipeline_run_id: UUID | None = None,
    ) -> IngestedDocument:
        """Persist a user suggestion as a source document.

        Writes to raw/user/<ts>-<slug>.md with source_type=user. body is
        expected to be substantive prose (either user-written or
        UI-reframed); this method does no reframing — it persists the
        authored content as a first-class source that enters the
        pipeline through the same rail as ingested documents.
        """
        if not body.strip():
            raise ValueError("body is empty")

        ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        anchor_slug = slugify(anchored_to) if anchored_to else "general"
        filename = f"{ts}-{anchor_slug}-{intent.value}.md"
        dest = _safe_upload_dest("user", filename)

        await self._ingest_raw(
            vault_id,
            storage,
            pipeline_run_id=pipeline_run_id,
            content=body,
            content_type="user",
            dest=dest,
            source_type="user",
            origin="user-suggestion",
            intent=intent.value,
            anchored_to=anchored_to,
            anchored_section=anchored_section,
        )
        return IngestedDocument(
            file_path=dest,
            title=filename,
        )

    async def ingest_session_exchange(
        self,
        vault_id: UUID,
        storage: Storage,
        *,
        session_id: str,
        exchange: ExchangeEvent,
        title: str,
        session_origin: SessionOrigin | None = None,
        pipeline_run_id: UUID | None = None,
    ) -> IngestedDocument:
        """Persist a promoted session exchange as a raw/sessions/ source.

        The path is content-addressable on ``exchange.exId`` so the
        documents-table upsert is idempotent on re-promotion.
        """
        dest = session_exchange_path(exchange.exId)
        await self._ingest_raw(
            vault_id,
            storage,
            pipeline_run_id=pipeline_run_id,
            dest=dest,
            **SessionService.session_exchange_build_args(
                session_id=session_id,
                exchange=exchange,
                title=title,
                session_origin=session_origin,
            ),
        )
        return IngestedDocument(
            file_path=dest,
            title=title,
        )

    async def ingest_url(
        self,
        vault_id: UUID,
        storage: Storage,
        url: str,
        metadata: SourceMetadata,
        *,
        pipeline_run_id: UUID | None = None,
    ) -> IngestedDocument:
        """Fetch a URL, convert to markdown, and ingest."""
        url = normalize_url(url)
        response = await _fetch_url(url)

        converter = MarkItDown()
        result = await asyncio.to_thread(
            converter.convert_stream,
            io.BytesIO(response.content),
            stream_info=StreamInfo(
                extension=".html",
                mimetype=response.headers.get("content-type", "text/html"),
            ),
        )

        title = metadata.title or result.title or url
        dest = raw_path(metadata.content_type, f"{slugify(title)}.md")

        await self._ingest_raw(
            vault_id,
            storage,
            pipeline_run_id=pipeline_run_id,
            content=result.text_content,
            content_type=metadata.content_type,
            dest=dest,
            source_type=metadata.source_type,
            title=title,
            **_metadata_extras(metadata, exclude_title=True),
        )
        return IngestedDocument(
            file_path=dest,
            title=title,
        )


def _metadata_extras(metadata: SourceMetadata, *, exclude_title: bool = False) -> dict:
    """Project SourceMetadata into **extras kwargs for ``write_document``.

    ``content_type`` and ``source_type`` are passed positionally; title
    is excluded when the caller is passing it explicitly.
    """
    exclude: set[str] = {"content_type", "source_type"}
    if exclude_title:
        exclude.add("title")
    return metadata.model_dump(by_alias=True, exclude_none=True, exclude=exclude)


def _safe_upload_dest(content_type: str, dest_path: str) -> str:
    content_type_path = PurePosixPath(content_type)
    if (
        not content_type
        or "\\" in content_type
        or content_type_path.is_absolute()
        or content_type_path.parts != (content_type,)
        or content_type in {".", ".."}
    ):
        raise ValueError(f"Invalid content_type: {content_type}")

    if "\\" in dest_path:
        raise ValueError(f"Invalid dest_path: {dest_path}")

    rel = PurePosixPath(dest_path)
    if not rel.parts or rel.is_absolute() or ".." in rel.parts:
        raise ValueError(f"Invalid dest_path: {dest_path}")

    return str(PurePosixPath("raw") / content_type / rel.with_suffix(".md"))


async def _convert_to_markdown(raw_bytes: bytes, filename: str, mimetype: str) -> str:
    ext = "." + filename.rsplit(".", 1)[-1].lower() if "." in filename else ".txt"
    if ext in (".md", ".txt", ".text", ".markdown"):
        return raw_bytes.decode("utf-8")
    converter = MarkItDown()
    result = await asyncio.to_thread(
        converter.convert_stream,
        io.BytesIO(raw_bytes),
        stream_info=StreamInfo(extension=ext, mimetype=mimetype),
    )
    return result.text_content


async def _fetch_url(url: str) -> httpx.Response:
    async with httpx.AsyncClient(follow_redirects=True, timeout=30.0) as client:
        response = await client.get(
            url,
            headers={
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            },
        )
        response.raise_for_status()
    return response
