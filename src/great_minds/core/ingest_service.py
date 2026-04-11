"""Ingest service: content conversion, ingestion, and indexing."""

import asyncio
import io
from pathlib import PurePosixPath
from uuid import UUID

import httpx
from markitdown import MarkItDown, StreamInfo

from great_minds.core.brain import load_config
from great_minds.core.ingester import ingest_document, normalize_url, slugify
from great_minds.core.documents.service import DocumentService
from great_minds.core.storage import Storage


class IngestService:
    def __init__(self, doc_service: DocumentService) -> None:
        self.doc_service = doc_service

    async def ingest_text(
        self,
        brain_id: UUID,
        storage: Storage,
        content: str,
        content_type: str,
        dest: str,
        *,
        title: str | None = None,
        author: str | None = None,
        date: str | int | None = None,
        origin: str | None = None,
        url: str | None = None,
    ) -> tuple[str, str]:
        """Ingest raw text content. Returns (file_path, title)."""
        config = load_config(storage)
        kwargs = _build_kwargs(
            title=title, author=author, date=date, origin=origin, url=url
        )
        result = ingest_document(
            storage, config, content, content_type, dest=dest, **kwargs
        )
        await self.doc_service.index_from_content(
            brain_id, dest, result, doc_kind=content_type
        )
        return dest, title or dest

    async def ingest_upload(
        self,
        brain_id: UUID,
        storage: Storage,
        raw_bytes: bytes,
        filename: str,
        content_type: str,
        *,
        mimetype: str = "",
        author: str | None = None,
        date: str | None = None,
        origin: str | None = None,
        url: str | None = None,
        dest_path: str | None = None,
    ) -> tuple[str, str]:
        """Ingest an uploaded file. Returns (file_path, title)."""
        content = await _convert_to_markdown(raw_bytes, filename, mimetype)

        if dest_path:
            dest = _safe_upload_dest(content_type, dest_path)
        else:
            slug = slugify(filename.rsplit(".", 1)[0])
            dest = _safe_upload_dest(content_type, f"{slug}.md")

        config = load_config(storage)
        kwargs = _build_kwargs(author=author, date=date, origin=origin, url=url)
        result = ingest_document(
            storage, config, content, content_type, dest=dest, **kwargs
        )
        await self.doc_service.index_from_content(
            brain_id, dest, result, doc_kind=content_type
        )
        return dest, filename

    async def ingest_url(
        self,
        brain_id: UUID,
        storage: Storage,
        url: str,
        content_type: str,
    ) -> tuple[str, str]:
        """Fetch a URL, convert to markdown, and ingest. Returns (file_path, title)."""
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

        title = result.title or url
        dest = f"raw/{content_type}/{slugify(title)}.md"

        config = load_config(storage)
        ingested = ingest_document(
            storage,
            config,
            result.text_content,
            content_type,
            dest=dest,
            title=title,
            url=url,
        )
        await self.doc_service.index_from_content(
            brain_id, dest, ingested, doc_kind=content_type
        )
        return dest, title


def _build_kwargs(**fields: str | int | None) -> dict:
    return {k: v for k, v in fields.items() if v is not None}


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
